// Only run inside the MCP Durable Object (or Node), never the public HTTP route.
// Timers cannot preempt synchronous PDF parsing; the runtime CPU/memory ceiling
// remains the final backstop for malicious compressed PDFs.
import { extractFormFields, type PdfFormField } from "./pdf-forms.js";
import { validOcrImageOptions, type PdfOcrImageOptions } from "./pdf-ocr-image.js";
export const PDF_LIMITS = { bytes: 5 * 1024 * 1024, documentPages: 200, pagesPerCall: 5, characters: 100_000, fieldsPerCall: 500, timeoutMs: 20_000, ocrTimeoutMs: 45_000 } as const;

export class PdfReadError extends Error {
  constructor(readonly code: string, message: string, readonly phase?: PdfReadPhase) { super(message); this.name = "PdfReadError"; }
}
export type PdfReadPhase = "resolve" | "download" | "integrity" | "extract" | "render" | "inference";

export interface PdfReadOptions extends PdfOcrImageOptions { startPage?: number; pageCount?: number; password?: string; ocr?: boolean }

export function validatePdfOptions(options: PdfReadOptions) {
  const startPage = options.startPage ?? 1, pageCount = options.pageCount ?? (options.ocr ? 1 : PDF_LIMITS.pagesPerCall);
  if (options.ocr !== undefined && typeof options.ocr !== "boolean") throw new PdfReadError("PDF_OCR_OPTIONS", "ocr must be a boolean.");
  if (!validOcrImageOptions(options) || (!options.ocr && (options.ocrRegion !== undefined || options.ocrRotation !== undefined))) {
    throw new PdfReadError("PDF_OCR_OPTIONS", "OCR rotation/region require ocr=true. Rotation must be 0, 90, 180 or 270 clockwise; region must lie inside the displayed page using fractions from 0 to 1, with width and height at least 0.01.");
  }
  if (options.ocr && pageCount !== 1) throw new PdfReadError("PDF_OCR_PAGE_LIMIT", "OCR supports one page per call. Set pageCount to 1.");
  if (!Number.isSafeInteger(startPage) || startPage < 1 || !Number.isSafeInteger(pageCount) || pageCount < 1 || pageCount > PDF_LIMITS.pagesPerCall) {
    throw new PdfReadError("PDF_PAGE_RANGE", "Choose a positive startPage and between 1 and 5 pages.");
  }
  if (options.password !== undefined && (typeof options.password !== "string" || options.password.length > 1024)) {
    throw new PdfReadError("PDF_PASSWORD_INVALID", "The supplied PDF password is invalid.");
  }
  return { startPage, pageCount };
}

export async function extractPdf(bytes: Uint8Array, options: PdfReadOptions = {}, signal = AbortSignal.timeout(PDF_LIMITS.timeoutMs)) {
  const { startPage, pageCount } = validatePdfOptions(options);
  if (!bytes.length || bytes.length > PDF_LIMITS.bytes) throw new PdfReadError("PDF_SIZE_LIMIT", "PDF extraction supports files up to 5 MiB.");
  if (!new TextDecoder("latin1").decode(bytes.subarray(0, 1024)).includes("%PDF-")) {
    throw new PdfReadError("PDF_INVALID", "The file does not contain a PDF header.");
  }
  // Lazy loading keeps ordinary tools independent of parser initialization.
  const { getResolvedPDFJS } = await import("unpdf");
  const { getDocument } = await getResolvedPDFJS();
  signal.throwIfAborted();
  const task = getDocument({
    data: bytes, password: options.password, verbosity: 0, stopAtErrors: true,
    useWorkerFetch: false, useSystemFonts: true, enableXfa: false,
    disableFontFace: true, isOffscreenCanvasSupported: false, isImageDecoderSupported: false,
    maxImageSize: 1_000_000, disableAutoFetch: true,
  });
  try {
    const pdf = await task.promise;
    signal.throwIfAborted();
    if (pdf.numPages > PDF_LIMITS.documentPages) throw new PdfReadError("PDF_PAGE_LIMIT", "PDF extraction supports documents up to 200 pages.");
    if (startPage > pdf.numPages) throw new PdfReadError("PDF_PAGE_RANGE", "startPage is beyond the last PDF page.");
    const endPage = Math.min(pdf.numPages, startPage + pageCount - 1);
    const tree = await pdf.getFieldObjects();
    const metadata = await pdf.getMetadata();
    const xfaPresent = Boolean((metadata.info as { IsXFAPresent?: boolean }).IsXFAPresent);
    const pages: Array<{ page: number; text: string; status: "text" | "no_text"; formFields: PdfFormField[] }> = [];
    let characters = 0;
    let fieldCount = 0;
    for (let number = startPage; number <= endPage; number++) {
      signal.throwIfAborted();
      const page = await pdf.getPage(number);
      const parts: string[] = [];
      let formFields: PdfFormField[] = [];
      try {
        // PDF.js assembles one page internally. Do not cancel its text stream
        // mid-page: the serverless build can reject pending stream callbacks.
        const content = await page.getTextContent();
        formFields = extractFormFields(await page.getAnnotations(), tree);
        fieldCount += formFields.length;
        characters += JSON.stringify(formFields).length;
        if (fieldCount > PDF_LIMITS.fieldsPerCall || characters > PDF_LIMITS.characters) throw new PdfReadError("PDF_OUTPUT_LIMIT", "Selected form fields exceed the output limit. Request fewer pages.");
        signal.throwIfAborted();
        for (const item of content.items) {
          if (!("str" in item)) continue;
          const part = item.str + (item.hasEOL ? "\n" : " ");
          characters += part.length;
          if (characters > PDF_LIMITS.characters) throw new PdfReadError("PDF_OUTPUT_LIMIT", "Selected pages exceed the text limit. Request fewer pages; a single dense page may remain unsupported.");
          parts.push(part);
        }
      } finally { page.cleanup(); }
      const text = parts.join("").trim();
      pages.push({ page: number, text, status: text ? "text" : "no_text", formFields });
    }
    signal.throwIfAborted();
    return {
      totalPages: pdf.numPages, startPage, endPage, pages,
      hasMore: endPage < pdf.numPages, nextPage: endPage < pdf.numPages ? endPage + 1 : null,
      extraction: "pdf_text_layer" as const,
      forms: { source: "acroform_parsed_values" as const, checkboxValues: "pdfjs_normalized_appearance_state" as const, xfaPresent, appearanceVerified: false, scope: "widgets_on_selected_pages" as const },
      warnings: [
        "Reading order and table layout may differ from the visual PDF. Images and non-form annotations are not extracted as text.",
        "Text/choice values are stored PDF values; checkbox states have separate provenance. Values are not visually verified. Stale appearances, hidden/non-widget fields, signatures and scripts are not evaluated. Review fields marked review_required; password fields are redacted.",
        "Checkbox values are PDF.js normalized states, which may come from /AS rather than raw /V. They are marked CHECKBOX_RAW_VALUE_UNVERIFIED; matching tree/widget values do not independently verify raw storage or visible marks.",
        ...(xfaPresent ? ["XFA forms are unsupported; AcroForm values may be incomplete or stale. Review the rendered page using OCR or a PDF viewer."] : []),
        ...(pages.some(p => p.status === "no_text") ? ["Some selected pages contain no extractable text. They may be blank or require OCR; no OCR was performed."] : []),
      ],
    };
  } catch (error) {
    if (signal.aborted) throw new PdfReadError("PDF_TIMEOUT", "PDF extraction exceeded its deadline.");
    if (error instanceof PdfReadError) throw error;
    if (error && typeof error === "object" && "name" in error && error.name === "PasswordException") {
      const required = "code" in error && error.code === 1;
      throw new PdfReadError(required ? "PDF_PASSWORD_REQUIRED" : "PDF_PASSWORD_INCORRECT", required ? "This PDF requires its password. Supply it only if the user authorizes its use in this conversation." : "The supplied PDF password did not unlock this document.");
    }
    // Never return parser messages: they may contain document strings.
    throw new PdfReadError("PDF_PARSE_FAILED", "The PDF could not be extracted. It may be damaged or use unsupported PDF features.");
  } finally {
    await task.destroy().catch(() => undefined);
  }
}
