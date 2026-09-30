import { BLOCK } from "./dct.js";

/**
 * Zigzag traversal table. zigzagTable[naturalIndex] = zigzag position.
 * natural index is y*8 + x (row, column).
 */
export const zigzagTable: number[] = [
  0, 1, 5, 6, 14, 15, 27, 28,
  2, 4, 7, 13, 16, 26, 29, 42,
  3, 8, 12, 17, 25, 30, 41, 43,
  9, 11, 18, 24, 31, 40, 44, 53,
  10, 19, 23, 32, 39, 45, 52, 54,
  20, 22, 33, 38, 46, 51, 55, 60,
  21, 34, 37, 47, 50, 56, 59, 61,
  35, 36, 48, 49, 57, 58, 62, 63,
];

/** Inverse map: for each zigzag position, the natural (y*8+x) index. */
export const inverseZigzagTable: number[] = (() => {
  const inv = new Array<number>(BLOCK * BLOCK);
  for (let natural = 0; natural < BLOCK * BLOCK; natural++) {
    inv[zigzagTable[natural]!] = natural;
  }
  return inv;
})();

/** Flatten a natural-order 8x8 coefficient matrix into zigzag order. */
export function toZigzag(block: number[][]): number[] {
  const out = new Array<number>(BLOCK * BLOCK);
  for (let y = 0; y < BLOCK; y++) {
    for (let x = 0; x < BLOCK; x++) {
      out[zigzagTable[y * BLOCK + x]!] = block[y]![x]!;
    }
  }
  return out;
}

/** Rebuild a natural-order 8x8 matrix from zigzag-order coefficients. */
export function fromZigzag(zig: number[]): number[][] {
  const block: number[][] = Array.from({ length: BLOCK }, () => new Array<number>(BLOCK).fill(0));
  for (let z = 0; z < BLOCK * BLOCK; z++) {
    const natural = inverseZigzagTable[z]!;
    const y = Math.floor(natural / BLOCK);
    const x = natural % BLOCK;
    block[y]![x] = zig[z]!;
  }
  return block;
}
