export type PaddingStrategy = "zero" | "edge" | "reflect";

export interface GrayImage {
  width: number;
  height: number;
  /** Row-major 8-bit samples, length === width * height, each in [0,255]. */
  pixels: number[];
}

export interface QuantTable {
  id?: number;
  name: string;
  /** 64 positive step values in natural (row, col) order; qc = round(c / step). */
  steps: number[];
}

export interface CompressParams {
  imageId: string;
  quantTableId: number;
  padding: PaddingStrategy;
  /** Client-supplied idempotency key; identical request returns the same artifact. */
  idempotencyKey: string;
}

export interface CompressedArtifact {
  id: string;
  imageId: string;
  quantTableId: number;
  padding: PaddingStrategy;
  formatVersion: number;
  width: number;
  height: number;
  blockCols: number;
  blockRows: number;
  byteLength: number;
  blob: Buffer;
  createdAt: string;
}

export interface ErrorReport {
  artifactId: string;
  imageId: string;
  width: number;
  height: number;
  mse: number;
  /** null encodes the explicit "infinite PSNR" state for zero error. */
  psnrDb: number | null;
  psnrState: "finite" | "infinite";
  maxError: number;
  errorMatrix: number[];
}
