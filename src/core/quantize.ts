import { BLOCK } from "./dct.js";
import { CodecError } from "./errors.js";
import { zigzagTable } from "./zigzag.js";

/**
 * Rounding rules (explicit, symmetric on negatives):
 *   q = truncTowardZero(c / step) is NOT used. Division rounding here is
 *   round-half-away-from-zero: sign(c) * floor(|c|/step + 0.5).
 * Reconstruction: c' = q * step (dequantization), then IDCT.
 */
export function quantizeCoefficient(c: number, step: number): number {
  if (!(step > 0) || !Number.isFinite(step)) {
    throw new CodecError("INVALID_QUANT_STEP", `quantization step must be positive, got ${step}`);
  }
  const r = Math.abs(c) / step;
  const q = Math.floor(r + 0.5);
  if (q === 0) return 0; // canonical zero, never -0
  return c < 0 ? -q : q;
}

export function dequantizeCoefficient(q: number, step: number): number {
  return q * step;
}

export function validateSteps(steps: number[]): void {
  if (!Array.isArray(steps) || steps.length !== BLOCK * BLOCK) {
    throw new CodecError("INVALID_QUANT_STEP", `quant table must contain ${BLOCK * BLOCK} steps`);
  }
  for (const s of steps) {
    if (typeof s !== "number" || !Number.isFinite(s) || s <= 0) {
      throw new CodecError("INVALID_QUANT_STEP", "every step must be a positive finite number");
    }
  }
}

export function quantizeBlock(coeffs: number[][], steps: number[]): number[][] {
  return coeffs.map((row, y) => row.map((c, x) => quantizeCoefficient(c, steps[y * BLOCK + x]!)));
}

export function dequantizeBlock(quantized: number[][], steps: number[]): number[][] {
  return quantized.map((row, y) => row.map((q, x) => dequantizeCoefficient(q, steps[y * BLOCK + x]!)));
}

/** Default quality tables, expressed in natural (row,col) order. */
export function uniformSteps(step: number): number[] {
  validateSteps(new Array<number>(BLOCK * BLOCK).fill(step));
  return new Array<number>(BLOCK * BLOCK).fill(step);
}

/**
 * Frequency-scaled table: step grows with the zigzag frequency index.
 * strength (0..100) maps to a multiplier; strength=0 is lossless-ish (step 1).
 */
export function scaledSteps(strength: number): number[] {
  if (!Number.isInteger(strength) || strength < 1 || strength > 100) {
    throw new CodecError("INVALID_QUANT_STEP", "strength must be an integer in [1,100]");
  }
  const steps = new Array<number>(BLOCK * BLOCK);
  const base = 0.1 + (strength / 100) * 19.9; // 0.2 .. 20
  for (let y = 0; y < BLOCK; y++) {
    for (let x = 0; x < BLOCK; x++) {
      const idx = zigzagTable[y * BLOCK + x]!;
      const s = Math.max(1, Math.round(base * (1 + idx / 8)));
      steps[y * BLOCK + x] = s;
    }
  }
  return steps;
}
