import { PdfReadError, type PdfReadPhase } from "./pdf-extract.js";
import type { PdfReadResult } from "./pdf-tools.js";

// One inference, bounded lifetime, no durable storage and no automatic retries.
export const PDF_JOB_LIMITS = { timeoutMs: 180_000, retentionMs: 180_000, initialWaitMs: 1_500, pollWaitMs: 10_000, maxResults: 4 } as const;
export interface PdfJobOptions {
  keepAlive(promise: Promise<unknown>): void;
  // Test-only clock bounds; production uses the constants above.
  limits?: Partial<Record<keyof typeof PDF_JOB_LIMITS, number>>;
}
type Outcome = { status: "complete"; result: PdfReadResult }
  | { status: "failed"; error_code: string; message: string; phase?: PdfReadPhase };
interface Job {
  id: string; phase: PdfReadPhase; startedAt: number; expiresAt: number;
  settled: Promise<void>; outcome?: Outcome;
}

/** Instantiate per authenticated MCP session; never share this map globally. */
export class PdfReadJobs {
  private readonly jobs = new Map<string, Job>();
  private readonly limits;
  constructor(private readonly options: PdfJobOptions) {
    this.limits = { ...PDF_JOB_LIMITS, ...options.limits };
  }

  async start(run: (signal: AbortSignal, onPhase: (phase: PdfReadPhase) => void) => Promise<PdfReadResult>) {
    this.prune();
    if ([...this.jobs.values()].some(job => !job.outcome)) {
      throw new PdfReadError("PDF_BUSY", "An OCR read is already running. Poll its jobId instead of starting another read.");
    }
    while (this.jobs.size >= this.limits.maxResults) this.jobs.delete(this.jobs.keys().next().value!);
    const controller = new AbortController();
    const startedAt = Date.now();
    const job: Job = { id: crypto.randomUUID(), phase: "resolve", startedAt,
      expiresAt: startedAt + this.limits.timeoutMs + this.limits.retentionMs, settled: Promise.resolve() };
    this.jobs.set(job.id, job);
    let abort!: () => void;
    const expired = new Promise<never>((_, reject) => {
      abort = () => reject(new PdfReadError("PDF_TIMEOUT", `PDF ${job.phase} exceeded its deadline.`, job.phase));
      controller.signal.addEventListener("abort", abort, { once: true });
    });
    const deadline = setTimeout(() => controller.abort(), this.limits.timeoutMs);
    job.settled = Promise.race([
      Promise.resolve().then(() => run(controller.signal, phase => { if (!job.outcome) job.phase = phase; })), expired,
    ]).then(result => { job.outcome = { status: "complete", result }; }, error => {
      const safe = error instanceof PdfReadError ? error : new PdfReadError("PDF_READ_FAILED", "Unable to complete the PDF read.");
      job.outcome = { status: "failed", error_code: safe.code, message: safe.message, phase: safe.phase ?? job.phase };
    }).finally(() => {
      clearTimeout(deadline);
      controller.signal.removeEventListener("abort", abort);
      job.expiresAt = Date.now() + this.limits.retentionMs;
      this.scheduleCleanup(job.id);
    });
    try { this.options.keepAlive(job.settled); }
    catch { controller.abort(); this.jobs.delete(job.id); throw new PdfReadError("PDF_OCR_UNAVAILABLE", "Background OCR is unavailable."); }
    return this.wait(job, this.limits.initialWaitMs);
  }

  async get(id: string) {
    this.prune();
    const job = this.jobs.get(id);
    if (!job) throw new PdfReadError("PDF_JOB_NOT_FOUND", "OCR job expired or is unavailable in this connector session. No new inference was started.");
    return this.wait(job, this.limits.pollWaitMs);
  }

  private prune() {
    for (const [id, job] of this.jobs) if (job.outcome && Date.now() >= job.expiresAt) this.jobs.delete(id);
  }
  private scheduleCleanup(id: string) {
    // Capture only the identifier, not the result: an evicted result must be
    // collectible immediately even while its expiry timer is still pending.
    const cleanup = setTimeout(() => this.jobs.delete(id), this.limits.retentionMs);
    cleanup.unref?.();
  }
  private async wait(job: Job, waitMs: number) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (!job.outcome) await Promise.race([job.settled, new Promise<void>(resolve => { timer = setTimeout(resolve, waitMs); })]);
      return { jobId: job.id, elapsedMs: Date.now() - job.startedAt, expiresAt: new Date(job.expiresAt).toISOString(),
        ...(job.outcome ?? { status: "pending" as const, phase: job.phase, nextTool: "kdrive_get_pdf_ocr_result", pollAfterMs: 1_000 }) };
    } finally { clearTimeout(timer); }
  }
}
