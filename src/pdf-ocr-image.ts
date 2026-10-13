export interface PdfOcrImageOptions {
  /** Clockwise correction after the PDF's display rotation. Never inferred. */
  ocrRotation?: 0 | 90 | 180 | 270;
  /** Fractions of the displayed page, top-left origin, before correction. */
  ocrRegion?: { x: number; y: number; width: number; height: number };
}

export function validOcrImageOptions(options: PdfOcrImageOptions): boolean {
  if (options.ocrRotation !== undefined && ![0, 90, 180, 270].includes(options.ocrRotation)) return false;
  const r = options.ocrRegion;
  return r === undefined || Boolean(r && [r.x, r.y, r.width, r.height].every(Number.isFinite)
    && r.x >= 0 && r.y >= 0 && r.width >= 0.01 && r.height >= 0.01
    && r.x + r.width <= 1 && r.y + r.height <= 1);
}

/** Bounded lossless pixel operations. Never threshold, erase marks or invent detail. */
export function transformOcrRaster(image: { data: Uint8Array; width: number; height: number }, options: PdfOcrImageOptions = {}) {
  if (!validOcrImageOptions(options)) throw new Error('Invalid OCR image options');
  const { width, height, data } = image;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1
    || width * height > 2_000_000 || data.length !== width * height * 4) throw new Error('Invalid OCR raster');
  const region = options.ocrRegion;
  const left = region ? Math.floor(region.x * width) : 0;
  const top = region ? Math.floor(region.y * height) : 0;
  const right = region ? Math.min(width, Math.ceil((region.x + region.width) * width)) : width;
  const bottom = region ? Math.min(height, Math.ceil((region.y + region.height) * height)) : height;
  let minX = right, minY = bottom, maxX = left - 1, maxY = top - 1;
  // Only fully opaque pure white is a removable margin. Even faint ink and
  // off-white scan backgrounds are preserved. No document-specific thresholds.
  for (let y = top; y < bottom; y++) for (let x = left; x < right; x++) {
    const i = (y * width + x) * 4;
    if (data[i] !== 255 || data[i + 1] !== 255 || data[i + 2] !== 255 || data[i + 3] !== 255) {
      minX = Math.min(minX, x); minY = Math.min(minY, y);
      maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
    }
  }
  const padding = 24;
  const hasInk = maxX >= minX;
  const x0 = hasInk ? Math.max(left, minX - padding) : left;
  const y0 = hasInk ? Math.max(top, minY - padding) : top;
  const x1 = hasInk ? Math.min(right, maxX + padding + 1) : right;
  const y1 = hasInk ? Math.min(bottom, maxY + padding + 1) : bottom;
  const cropWidth = x1 - x0, cropHeight = y1 - y0;
  const rotation = options.ocrRotation ?? 0;
  const swap = rotation === 90 || rotation === 270;
  const outWidth = swap ? cropHeight : cropWidth, outHeight = swap ? cropWidth : cropHeight;
  const output = new Uint8Array(outWidth * outHeight * 4);
  for (let y = 0; y < cropHeight; y++) for (let x = 0; x < cropWidth; x++) {
    const dx = rotation === 90 ? cropHeight - 1 - y : rotation === 180 ? cropWidth - 1 - x : rotation === 270 ? y : x;
    const dy = rotation === 90 ? x : rotation === 180 ? cropHeight - 1 - y : rotation === 270 ? cropWidth - 1 - x : y;
    const source = ((y + y0) * width + x + x0) * 4;
    const target = (dy * outWidth + dx) * 4;
    output[target] = data[source]; output[target + 1] = data[source + 1];
    output[target + 2] = data[source + 2]; output[target + 3] = data[source + 3];
  }
  return {
    data: output, width: outWidth, height: outHeight,
    preparation: {
      scope: region ? 'region' as const : 'full_page' as const,
      sourceWidth: width, sourceHeight: height,
      region: region ?? null, rotation,
      crop: { x: x0, y: y0, width: cropWidth, height: cropHeight },
      whiteMarginsTrimmed: x0 !== left || y0 !== top || x1 !== right || y1 !== bottom,
    },
  };
}
