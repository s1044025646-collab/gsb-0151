// Orthonormal (orthogonal, energy-preserving) 8x8 DCT-II and inverse DCT-III.
// Pixel domain values are centered to signed levels before the transform.

export const BLOCK = 8;
export const N = 8;
export const LEVEL_SHIFT = 128;

function basisCoeff(k: number): number {
  return k === 0 ? Math.sqrt(1 / N) : Math.sqrt(2 / N);
}

const C = new Array<number>(N);
const cosTable: number[][] = [];
for (let k = 0; k < N; k++) {
  C[k] = basisCoeff(k);
  cosTable[k] = new Array<number>(N);
  for (let n = 0; n < N; n++) {
    cosTable[k][n] = Math.cos(((2 * n + 1) * k * Math.PI) / (2 * N));
  }
}

export type Matrix = number[][];

export function createBlock(): Matrix {
  return Array.from({ length: N }, () => new Array<number>(N).fill(0));
}

// Forward DCT on a centered block (levels in roughly [-128, 127]).
export function forwardDCT(block: Matrix): Matrix {
  const out = createBlock();
  for (let u = 0; u < N; u++) {
    for (let v = 0; v < N; v++) {
      let sum = 0;
      for (let x = 0; x < N; x++) {
        for (let y = 0; y < N; y++) {
          sum += block[x][y] * cosTable[u][x] * cosTable[v][y];
        }
      }
      out[u][v] = C[u] * C[v] * sum;
    }
  }
  return out;
}

// Inverse DCT; callers are responsible for pixel clipping after de-centering.
export function inverseDCT(coeffs: Matrix): Matrix {
  const out = createBlock();
  for (let x = 0; x < N; x++) {
    for (let y = 0; y < N; y++) {
      let sum = 0;
      for (let u = 0; u < N; u++) {
        for (let v = 0; v < N; v++) {
          sum += C[u] * C[v] * coeffs[u][v] * cosTable[u][x] * cosTable[v][y];
        }
      }
      out[x][y] = sum;
    }
  }
  return out;
}

// Round half away from zero (explicit rule for negative numbers).
export function roundHalfAwayFromZero(value: number): number {
  return value >= 0 ? Math.floor(value + 0.5) : Math.ceil(value - 0.5);
}
