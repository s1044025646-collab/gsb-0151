import { BLOCK } from "./dct.js";
import { CodecError } from "./errors.js";
import type { GrayImage, PaddingStrategy } from "./types.js";

export const MAX_DIMENSION = 65535;

export function validateImage(img: GrayImage): void {
  if (!Number.isInteger(img.width) || !Number.isInteger(img.height)) {
    throw new CodecError("INVALID_DIMENSIONS", "width/height must be integers");
  }
  if (img.width <= 0 || img.height <= 0) {
    throw new CodecError("INVALID_DIMENSIONS", "width/height must be positive");
  }
  if (img.width > MAX_DIMENSION || img.height > MAX_DIMENSION) {
    throw new CodecError(
      "SIZE_OVERFLOW",
      `dimensions must not exceed ${MAX_DIMENSION}`,
      { width: img.width, height: img.height },
    );
  }
  const expected = img.width * img.height;
  if (!Array.isArray(img.pixels) || img.pixels.length !== expected) {
    throw new CodecError("INVALID_DIMENSIONS", "pixel count must equal width*height", {
      expected,
      actual: img.pixels?.length,
    });
  }
  for (const p of img.pixels) {
    if (!Number.isInteger(p) || p < 0 || p > 255) {
      throw new CodecError("INVALID_PIXEL_VALUE", "every pixel must be an integer in [0,255]");
    }
  }
}

export function blockGrid(width: number, height: number): { cols: number; rows: number; pw: number; ph: number } {
  const cols = Math.ceil(width / BLOCK);
  const rows = Math.ceil(height / BLOCK);
  const pw = cols * BLOCK;
  const ph = rows * BLOCK;
  if (pw > MAX_DIMENSION || ph > MAX_DIMENSION) {
    throw new CodecError("SIZE_OVERFLOW", "padded dimensions overflow limit", { pw, ph });
  }
  return { cols, rows, pw, ph };
}

/**
 * Level shift / centering: samples in [0,255] -> [-128,127] before DCT.
 */
export function centerPixel(p: number): number {
  return p - 128;
}

export function uncenterPixel(c: number): number {
  return c + 128;
}

/** Clip a reconstructed level-shifted value back to an 8-bit sample. */
export function clipSample(v: number): number {
  const s = Math.round(v + 128);
  if (s < 0) return 0;
  if (s > 255) return 255;
  return s;
}

function paddedSourceValue(img: GrayImage, x: number, y: number, strategy: PaddingStrategy): number {
  if (x < img.width && y < img.height) return img.pixels[y * img.width + x]!;
  switch (strategy) {
    case "zero":
      return 0;
    case "edge": {
      const ex = Math.min(x, img.width - 1);
      const ey = Math.min(y, img.height - 1);
      return img.pixels[ey * img.width + ex]!;
    }
    case "reflect": {
      const rx = x < img.width ? x : 2 * img.width - x - 2;
      const ry = y < img.height ? y : 2 * img.height - y - 2;
      return img.pixels[ry * img.width + rx]!;
    }
    default:
      throw new CodecError("INVALID_PADDING", `unknown padding strategy: ${String(strategy)}`);
  }
}

/** Extract block (bx,by) from the image as an 8x8 level-shifted matrix. */
export function extractBlock(
  img: GrayImage,
  bx: number,
  by: number,
  strategy: PaddingStrategy,
): number[][] {
  const out: number[][] = [];
  for (let y = 0; y < BLOCK; y++) {
    const row: number[] = [];
    for (let x = 0; x < BLOCK; x++) {
      const gx = bx * BLOCK + x;
      const gy = by * BLOCK + y;
      row.push(centerPixel(paddedSourceValue(img, gx, gy, strategy)));
  }
    out.push(row);
  }
  return out;
}

/** Crop a padded (pw x ph) row-major array back to the original valid rectangle. */
export function cropToOriginal(padded: number[], pw: number, width: number, height: number): number[] {
  const out: number[] = new Array<number>(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      out[y * width + x] = padded[y * pw + x]!;
    }
  }
  return out;
}
