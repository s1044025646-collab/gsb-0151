/**
 * 8x8 orthonormal DCT-II / DCT-III.
 *
 * Basis:
 *   C[u] = sqrt(1/8)               for u = 0
 *        = sqrt(2/8) = 1/2         for u > 0
 *   F[u,v] = C[u] C[v] sum_{x,y} s[x,y]
              cos((2x+1) u pi / 16) cos((2y+1) v pi / 16)
 *
 * Separable implementation: forward = D (rows) then D (cols),
 * inverse = D^T (cols) then D^T (rows). The transform matrix is
 * orthonormal, so Parseval energy relation holds exactly
 * (up to floating point rounding): sum s^2 == sum F^2.
 */

export const BLOCK = 8;

const SQRT1_8 = Math.sqrt(1 / 8);
const SQRT2_8 = Math.sqrt(2 / 8);

/** Orthonormal 8-point DCT matrix, T[k][n]. */
export const T: number[][] = (() => {
  const m: number[][] = [];
  for (let k = 0; k < 8; k++) {
    const row: number[] = [];
    for (let n = 0; n < 8; n++) {
      row.push((k === 0 ? SQRT1_8 : SQRT2_8) * Math.cos(((2 * n + 1) * k * Math.PI) / 16));
    }
    m.push(row);
  }
  return m;
})();

function mulMatrix(a: number[][], b: number[][]): number[][] {
  const out: number[][] = Array.from({ length: 8 }, () => new Array<number>(8).fill(0));
  for (let i = 0; i < 8; i++) {
    for (let j = 0; j < 8; j++) {
      let sum = 0;
      for (let k = 0; k < 8; k++) sum += a[i]![k]! * b[k]![j]!;
      out[i]![j] = sum;
    }
  }
  return out;
}

/** Forward 2D DCT: F = T S T^T. Input/output are 8x8 row-major arrays. */
export function dct2d(block: number[][]): number[][] {
  const tmp = mulMatrix(T, block);
  const tt: number[][] = T.map((row) => row.slice());
  // transpose T -> T^T
  const tT: number[][] = Array.from({ length: 8 }, () => new Array<number>(8));
  for (let i = 0; i < 8; i++) for (let j = 0; j < 8; j++) tT[j]![i] = tt[i]![j]!;
  return mulMatrix(tmp, tT);
}

/** Inverse 2D DCT: S = T^T F T. */
export function idct2d(coeffs: number[][]): number[][] {
  const tT: number[][] = Array.from({ length: 8 }, () => new Array<number>(8));
  for (let i = 0; i < 8; i++) for (let j = 0; j < 8; j++) tT[j]![i] = T[i]![j]!;
  const tmp = mulMatrix(tT, coeffs);
  return mulMatrix(tmp, T);
}
