import { BLOCK, createBlock, forwardDCT, inverseDCT, roundHalfAwayFromZero } from './dct';
import { fail } from './errors';

export type QuantTable = number[]; // 64 positive step sizes in natural (row-major) order

export function validateQuantTable(steps: readonly number[]): asserts steps is QuantTable {
  if (!Array.isArray(steps) || steps.length !== BLOCK * BLOCK) {
    fail('INVALID_QUANT_STEP', `quantization table must contain ${BLOCK * BLOCK} entries`);
  }
  for (let i = 0; i < steps.length; i++) {
    const q = steps[i];
    if (typeof q !== 'number' || !Number.isFinite(q) || q <= 0) {
      fail('INVALID_QUANT_STEP', `quantization step at index ${i} must be a positive finite number`);
    }
  }
}

// Normalize forward coefficients to integer levels using half-away-from-zero rounding.
export function quantizeBlock(centered: number[][], table: QuantTable): number[][] {
  validateQuantTable(table);
  const coeffs = forwardDCT(centered);
  const out = createBlock();
  for (let r = 0; r < BLOCK; r++) {
    for (let c = 0; c < BLOCK; c++) {
      const step = table[r * BLOCK + c];
      out[r][c] = roundHalfAwayFromZero(coeffs[r][c] / step);
    }
  }
  return out;
}

// Denormalize integer levels back to transform coefficients.
export function dequantizeBlock(levels: number[][], table: QuantTable): number[][] {
  validateQuantTable(table);
  const out = createBlock();
  for (let r = 0; r < BLOCK; r++) {
    for (let c = 0; c < BLOCK; c++) {
      out[r][c] = levels[r][c] * table[r * BLOCK + c];
    }
  }
  return out;
}

// Reconstruct centered (signed) levels from quantized integer levels.
export function reconstructCentered(levels: number[][], table: QuantTable): number[][] {
  return inverseDCT(dequantizeBlock(levels, table));
}

// Uniform table: every coefficient position uses the same step.
export function uniformTable(step: number): QuantTable {
  if (!(step > 0) || !Number.isFinite(step)) {
    fail('INVALID_QUANT_STEP', 'uniform table base step must be positive');
  }
  return new Array<number>(BLOCK * BLOCK).fill(step);
}
