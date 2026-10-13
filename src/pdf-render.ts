import { PdfReadError } from "./pdf-extract.js";

export const OCR_RENDER_LIMITS = { maxPixels: 2_000_000, maxDimension: 2000, maxPngBytes: 4 * 1024 * 1024 } as const;
export async function renderPdfPage(bytes: Uint8Array, pageNumber: number, password?: string, wasm?: WebAssembly.Module) {
  const { PDFiumLibrary } = await import("@hyzyla/pdfium");
  const { encode } = await import("fast-png");
  const library = await PDFiumLibrary.init(wasm ? {
    instantiateWasm(imports, callback) { callback(new WebAssembly.Instance(wasm, imports), wasm); },
  } : undefined);
  try {
    const doc = await library.loadDocument(bytes, password);
    try {
      if (pageNumber < 1 || pageNumber > doc.getPageCount()) throw new PdfReadError("PDF_PAGE_RANGE", "OCR page is outside this document.");
      const page = doc.getPage(pageNumber - 1);
      try {
        const { originalWidth: w, originalHeight: h } = page.getOriginalSize();
        if (!(w > 0 && h > 0 && Number.isFinite(w) && Number.isFinite(h))) throw new PdfReadError("PDF_RENDER_FAILED", "Invalid PDF page dimensions.");
        const scale = Math.min(2, OCR_RENDER_LIMITS.maxDimension / Math.max(w, h), Math.sqrt(OCR_RENDER_LIMITS.maxPixels / (w * h)));
        const image = await page.render({ scale, renderFormFields: true, transparent: false, render: async x => {
          if (x.width * x.height > OCR_RENDER_LIMITS.maxPixels) throw new PdfReadError("PDF_RENDER_LIMIT", "PDF page exceeds the OCR image limit.");
          return encode({ width: x.width, height: x.height, data: x.data, channels: 4 });
        } });
        if (image.data.length > OCR_RENDER_LIMITS.maxPngBytes) throw new PdfReadError("PDF_RENDER_LIMIT", "Rendered page exceeds the OCR image byte limit.");
        return { png: image.data, width: image.width, height: image.height };
      } finally { page.close(); }
    } finally { doc.destroy(); }
  } finally { library.destroy(); }
}
