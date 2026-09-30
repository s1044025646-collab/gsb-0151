import type { GrayImage } from "./types.js";

/** Deterministic PRNG (mulberry32) so tests and demos are repeatable. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function make(width: number, height: number, fn: (x: number, y: number) => number): GrayImage {
  const pixels = new Array<number>(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) pixels[y * width + x] = Math.max(0, Math.min(255, Math.round(fn(x, y))));
  }
  return { width, height, pixels };
}

export function constantImage(size = 16, value = 128, nonMultiple = false): GrayImage {
  const w = nonMultiple ? size + 3 : size;
  const h = nonMultiple ? size + 5 : size;
  return make(w, h, () => value);
}

export function gradientImage(width = 20, height = 13): GrayImage {
  return make(width, height, (x, y) => (255 * (x + y)) / (width + height - 2));
}

export function checkerImage(width = 19, height = 11, cell = 2): GrayImage {
  return make(width, height, (x, y) => ((Math.floor(x / cell) + Math.floor(y / cell)) % 2 === 0 ? 30 : 220));
}

export function impulseImage(width = 17, height = 17): GrayImage {
  return make(width, height, (x, y) => {
    if (x === Math.floor(width / 2) && y === Math.floor(height / 2)) return 255;
    if (x === 0 && y === 0) return 200;
    return 8;
  });
}

export function randomImage(width = 33, height = 21, seed = 20260930): GrayImage {
  const rand = mulberry32(seed);
  return make(width, height, () => rand() * 255);
}

export function allFixtures(): Record<string, GrayImage> {
  return {
    constant: constantImage(16, 128, false),
    constantOdd: constantImage(16, 128, true),
    gradient: gradientImage(),
    checker: checkerImage(),
    impulse: impulseImage(),
    random: randomImage(),
  };
}
