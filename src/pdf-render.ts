import { PdfReadError } from "./pdf-extract.js";
import { transformOcrRaster, validOcrImageOptions, type PdfOcrImageOptions } from "./pdf-ocr-image.js";

export const OCR_RENDER_LIMITS = { maxPixels: 2_000_000, maxDimension: 2000, maxPngBytes: 4 * 1024 * 1024 } as const;
export async function renderPdfPage(bytes: Uint8Array, pageNumber: number, password?: string, wasm?: WebAssembly.Module) {
  return renderPdf(bytes, pageNumber, password, wasm);
}
export async function renderPdfOcrPage(bytes: Uint8Array, pageNumber: number, password?: string, options: PdfOcrImageOptions = {}, wasm?: WebAssembly.Module) {
  if (!validOcrImageOptions(options)) throw new PdfReadError("PDF_OCR_OPTIONS", "Choose a valid OCR rotation and region.");
  return renderPdf(bytes, pageNumber, password, wasm, options);
}
async function renderPdf(bytes: Uint8Array, pageNumber: number, password?: string, wasm?: WebAssembly.Module, options?: PdfOcrImageOptions) {
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
        let prepared: ReturnType<typeof transformOcrRaster> | undefined;
        const image = await page.render({ scale, renderFormFields: true, transparent: false, render: async x => {
          if (x.width * x.height > OCR_RENDER_LIMITS.maxPixels) throw new PdfReadError("PDF_RENDER_LIMIT", "PDF page exceeds the OCR image limit.");
          prepared = options ? transformOcrRaster(x, options) : undefined;
          const raster = prepared ?? x;
          return encode({ width: raster.width, height: raster.height, data: raster.data, channels: 4 });
        } });
        if (image.data.length > OCR_RENDER_LIMITS.maxPngBytes) throw new PdfReadError("PDF_RENDER_LIMIT", "Rendered page exceeds the OCR image byte limit.");
        return { png: image.data, width: prepared?.width ?? image.width, height: prepared?.height ?? image.height, preparation: prepared?.preparation };
      } finally { page.close(); }
    } finally { doc.destroy(); }
  } finally { library.destroy(); }
}
