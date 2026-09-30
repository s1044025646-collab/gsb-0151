import { BLOCK } from './dct';
import {
  clipCenteredToPixel,
  extractCenteredBlock,
  GrayImage,
  paddedDimensions,
  PaddingStrategy,
} from './image';
import { QuantTable, quantizeBlock, reconstructCentered, validateQuantTable } from './quantize';
import { parseContainer, serializeContainer } from './container';

export interface CompressResult {
  container: Buffer;
  bytes: number;
  blockRows: number;
  blockCols: number;
}

export function compressImage(image: GrayImage, quant: QuantTable, padding: PaddingStrategy): CompressResult {
  validateQuantTable(quant);
  const { pw, ph } = paddedDimensions(image.width, image.height);
  const blockCols = pw / BLOCK;
  const blockRows = ph / BLOCK;
  const levels: number[][][] = [];
  for (let br = 0; br < blockRows; br++) {
    for (let bc = 0; bc < blockCols; bc++) {
      const centered = extractCenteredBlock(image, br, bc, padding);
      levels.push(quantizeBlock(centered, quant));
    }
  }
  const container = serializeContainer({
    width: image.width,
    height: image.height,
    padding,
    quant,
    blocks: levels,
  });
  return { container, bytes: container.length, blockRows, blockCols };
}

// Decompress using ONLY the container header and payload. Padding is cropped
// away using the stored original dimensions.
export function decompressContainer(container: Buffer): GrayImage {
  const parsed = parseContainer(container);
  const { width, height } = parsed;
  const { pw, ph } = paddedDimensions(width, height);
  const blockCols = pw / BLOCK;
  const blockRows = ph / BLOCK;
  const pixels = new Uint8Array(width * height);

  let index = 0;
  for (let br = 0; br < blockRows; br++) {
    for (let bc = 0; bc < blockCols; bc++) {
      const levels = parsed.blocks[index++];
      const centered = reconstructCentered(levels, parsed.quant);
      for (let x = 0; x < BLOCK; x++) {
        for (let y = 0; y < BLOCK; y++) {
          const gx = br * BLOCK + x;
          const gy = bc * BLOCK + y;
          if (gx < height && gy < width) {
            pixels[gx * width + gy] = clipCenteredToPixel(centered[x][y]);
          }
        }
      }
    }
  }
  return { width, height, pixels };
}

export interface ErrorReport {
  width: number;
  height: number;
  validPixels: number;
  mse: number;
  psnr: number | null; // null represents +Infinity for zero MSE
  psnrState: 'finite' | 'infinity';
  maxError: number;
  errorMatrix: Int32Array; // |orig - recon| over valid pixels only
}

// Metrics are computed only over original valid pixels (padding never counted).
export function compareImages(original: GrayImage, rebuilt: GrayImage): ErrorReport {
  if (original.width !== rebuilt.width || original.height !== rebuilt.height) {
    throw new Error('compareImages requires equal dimensions');
  }
  const count = original.width * original.height;
  const errorMatrix = new Int32Array(count);
  let sumSquares = 0;
  let maxError = 0;
  for (let i = 0; i < count; i++) {
    const diff = original.pixels[i] - rebuilt.pixels[i];
    const abs = diff < 0 ? -diff : diff;
    errorMatrix[i] = abs;
    sumSquares += diff * diff;
    if (abs > maxError) maxError = abs;
  }
  const mse = sumSquares / count;
  const base = { width: original.width, height: original.height, validPixels: count, mse, maxError, errorMatrix };
  if (mse === 0) {
    return { ...base, psnr: null, psnrState: 'infinity' };
  }
  const psnr = 10 * Math.log10((255 * 255) / mse);
  return { ...base, psnr, psnrState: 'finite' };
}
