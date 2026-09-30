import { BLOCK, LEVEL_SHIFT } from './dct';
import { fail } from './errors';

export const MAX_DIMENSION = 65535;

export type PaddingStrategy = 'zero' | 'edge';

export interface GrayImage {
  width: number;
  height: number;
  // row-major 8-bit grayscale pixels, length === width*height
  pixels: Uint8Array;
}

export function validateImage(width: number, height: number, pixels: ArrayLike<number>): void {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    fail('VALIDATION', 'image dimensions must be positive integers');
  }
  if (width > MAX_DIMENSION || height > MAX_DIMENSION) {
    fail('DIMENSION_OVERFLOW', `dimensions must not exceed ${MAX_DIMENSION}`);
  }
  if (pixels.length !== width * height) {
    fail('VALIDATION', `pixel count ${pixels.length} does not match ${width}x${height}`);
  }
  for (let i = 0; i < pixels.length; i++) {
    const p = pixels[i];
    if (!Number.isInteger(p) || p < 0 || p > 255) {
      fail('INVALID_PIXEL', `pixel at index ${i} is not an 8-bit grayscale value`);
    }
  }
}

export function makeImage(width: number, height: number, pixels: ArrayLike<number>): GrayImage {
  validateImage(width, height, pixels);
  const copy = new Uint8Array(width * height);
  for (let i = 0; i < pixels.length; i++) copy[i] = pixels[i];
  return { width, height, pixels: copy };
}

export function paddedDimensions(width: number, height: number): { pw: number; ph: number } {
  return {
    pw: Math.ceil(width / BLOCK) * BLOCK,
    ph: Math.ceil(height / BLOCK) * BLOCK,
  };
}

// Extract a padded 8x8 block in centered (level-shifted) domain.
export function extractCenteredBlock(
  image: GrayImage,
  blockRow: number,
  blockCol: number,
  strategy: PaddingStrategy
): number[][] {
  if (strategy !== 'zero' && strategy !== 'edge') {
    fail('INVALID_PADDING', `unknown padding strategy: ${String(strategy)}`);
  }
  const block = Array.from({ length: BLOCK }, () => new Array<number>(BLOCK).fill(0));
  const x0 = blockRow * BLOCK;
  const y0 = blockCol * BLOCK;
  for (let x = 0; x < BLOCK; x++) {
    for (let y = 0; y < BLOCK; y++) {
      const gx = x0 + x;
      const gy = y0 + y;
      let level: number;
      if (gx < image.height && gy < image.width) {
        level = image.pixels[gx * image.width + gy] - LEVEL_SHIFT;
      } else if (strategy === 'zero') {
        level = 0 - LEVEL_SHIFT; // gray 128 in unsigned domain -> zero after centering
      } else {
        const cx = Math.min(gx, image.height - 1);
        const cy = Math.min(gy, image.width - 1);
        level = image.pixels[cx * image.width + cy] - LEVEL_SHIFT;
      }
      block[x][y] = level;
    }
  }
  return block;
}

// Clip a centered reconstruction level back to an 8-bit pixel.
export function clipCenteredToPixel(level: number): number {
  const value = Math.round(level + LEVEL_SHIFT);
  if (value < 0) return 0;
  if (value > 255) return 255;
  return value;
}
