/** Race cancellation even when a host adapter does not honor AbortSignal. */
export async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  let abort = () => {};
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason ?? new DOMException("Cancelled", "AbortError"));
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
  try { return await Promise.race([promise, cancelled]); }
  finally { signal.removeEventListener("abort", abort); }
}

export function waitForRetry(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
}

/** Local CLI only: retry read request failures, never writes or partial bodies. */
export function transferFetch(fetcher: typeof fetch = fetch, options: {
  wait?: typeof waitForRetry; random?: () => number; now?: () => number;
} = {}): typeof fetch {
  return async (input, init) => {
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined) ?? AbortSignal.timeout(30_000);
    const safe = method === "GET" || method === "HEAD";
    const request = { ...init, signal };
    for (let attempt = 0; ; attempt++) {
      signal.throwIfAborted();
      let response: Response;
      let delay = Math.floor(250 * 2 ** attempt + (options.random ?? Math.random)() * 100);
      try {
        response = await abortable(fetcher(input, request), signal);
      } catch (error) {
        signal.throwIfAborted();
        if (!safe || attempt >= 2 || !(error instanceof TypeError)) throw error;
        await (options.wait ?? waitForRetry)(delay, signal);
        continue;
      }
      if (!safe || attempt >= 2 || ![429, 502, 503, 504].includes(response.status)) return response;
      const retryAfter = response.headers.get("retry-after");
      if (retryAfter !== null) {
        const requested = /^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000
          : Date.parse(retryAfter) - (options.now ?? Date.now)();
        // Never retry sooner than requested; long/invalid waits are surfaced to the caller.
        if (!Number.isFinite(requested) || requested > 5000) return response;
        delay = Math.max(0, requested);
      }
      await response.body?.cancel();
      await (options.wait ?? waitForRetry)(delay, signal);
    }
  };
}
