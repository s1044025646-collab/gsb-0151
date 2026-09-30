import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { withTransaction } from "./db.js";
import { CodecError } from "../core/errors.js";
import { validateImage } from "../core/image.js";
import { validateSteps } from "../core/quantize.js";
import { compress, decompress } from "../core/codec.js";
import { computeError } from "../core/metrics.js";
import type {
  CompressedArtifact,
  GrayImage,
  PaddingStrategy,
  QuantTable,
} from "../core/types.js";

export interface Clock {
  now(): string;
  uuid(): string;
}

export const defaultClock: Clock = {
  now: () => new Date().toISOString(),
  uuid: () => randomUUID(),
};

export interface Page<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

export interface RepoContext {
  db: DatabaseSync;
  clock?: Clock;
}

function pixelsToBlob(pixels: number[]): Buffer {
  return Buffer.from(pixels);
}

function blobToPixels(blob: Buffer): number[] {
  return Array.from(Buffer.from(blob));
}

function stepsToBlob(steps: number[]): Buffer {
  const buf = Buffer.alloc(steps.length * 4);
  steps.forEach((s, i) => buf.writeFloatLE(s, i * 4));
  return buf;
}

function blobToSteps(blob: Buffer): number[] {
  const out: number[] = [];
  const buf = Buffer.from(blob);
  for (let i = 0; i < buf.length; i += 4) out.push(buf.readFloatLE(i));
  return out;
}

export function checksum(img: GrayImage): string {
  return createHash("sha256")
    .update(`${img.width}x${img.height}:`)
    .update(Buffer.from(img.pixels))
    .digest("hex");
}

export class Repository {
  private readonly clock: Clock;
  private readonly db: DatabaseSync;
  constructor(db: DatabaseSync, clock?: Clock) {
    this.db = db;
    this.clock = clock ?? defaultClock;
  }

  importImage(name: string, img: GrayImage): { id: string; reused: boolean } {
    validateImage(img);
    const sum = checksum(img);
    const existing = this.db
      .prepare("SELECT id FROM images WHERE checksum = ? AND width = ? AND height = ?")
      .get(sum, img.width, img.height) as { id: string } | undefined;
    if (existing) return { id: existing.id, reused: true };
    const id = this.clock.uuid();
    this.db
      .prepare(
        "INSERT INTO images (id,name,width,height,pixels,checksum,created_at) VALUES (?,?,?,?,?,?,?)",
      )
      .run(id, name, img.width, img.height, pixelsToBlob(img.pixels), sum, this.clock.now());
    return { id, reused: false };
  }

  getImage(id: string): (GrayImage & { name: string }) | null {
    const row = this.db
      .prepare("SELECT id,name,width,height,pixels FROM images WHERE id = ?")
      .get(id) as
      | { id: string; name: string; width: number; height: number; pixels: Buffer }
      | undefined;
    if (!row) return null;
    return { name: row.name, width: row.width, height: row.height, pixels: blobToPixels(row.pixels) };
  }

  listImages(limit: number, offset: number): Page<{ id: string; name: string; width: number; height: number; created_at: string }> {
    const total = (this.db.prepare("SELECT COUNT(*) AS c FROM images").get() as { c: number }).c;
    const items = this.db
      .prepare("SELECT id,name,width,height,created_at FROM images ORDER BY created_at,id LIMIT ? OFFSET ?")
      .all(limit, offset) as { id: string; name: string; width: number; height: number; created_at: string }[];
    return { items, total, limit, offset };
  }

  createQuantTable(table: QuantTable): number {
    validateSteps(table.steps);
    const existing = this.db.prepare("SELECT id FROM quant_tables WHERE name = ?").get(table.name) as
      | { id: number }
      | undefined;
    if (existing) return existing.id;
    const info = this.db
      .prepare("INSERT INTO quant_tables (name,steps,created_at) VALUES (?,?,?)")
      .run(table.name, stepsToBlob(table.steps), this.clock.now());
    return Number(info.lastInsertRowid);
  }

  getQuantTable(id: number): (QuantTable & { created_at: string }) | null {
    const row = this.db.prepare("SELECT id,name,steps,created_at FROM quant_tables WHERE id = ?").get(id) as
      | { id: number; name: string; steps: Buffer; created_at: string }
      | undefined;
    if (!row) return null;
    return { id: row.id, name: row.name, steps: blobToSteps(row.steps), created_at: row.created_at };
  }

  listQuantTables(limit: number, offset: number): Page<{ id: number; name: string; created_at: string }> {
    const total = (this.db.prepare("SELECT COUNT(*) AS c FROM quant_tables").get() as { c: number }).c;
    const items = this.db
      .prepare("SELECT id,name,created_at FROM quant_tables ORDER BY id LIMIT ? OFFSET ?")
      .all(limit, offset) as { id: number; name: string; created_at: string }[];
    return { items, total, limit, offset };
  }

  /**
   * Create a compressed artifact. Idempotent: the same
   * (image, quant table, padding, idempotencyKey) returns the stored artifact.
   * Different parameters (including key) produce independent artifacts.
   */
  compress(params: {
    imageId: string;
    quantTableId: number;
    padding: PaddingStrategy;
    idempotencyKey: string;
  }): { artifact: CompressedArtifact; replayed: boolean } {
    const replay = this.db
      .prepare(
        "SELECT * FROM artifacts WHERE image_id=? AND quant_table_id=? AND padding=? AND idempotency_key=?",
      )
      .get(params.imageId, params.quantTableId, params.padding, params.idempotencyKey) as unknown as
      | ArtifactRow
      | undefined;
    if (replay) {
      return { artifact: rowToArtifact(replay), replayed: true };
    }

    return withTransaction(this.db, () => {
      const image = this.getImage(params.imageId);
      if (!image) throw new CodecError("NOT_FOUND", `image ${params.imageId} not found`);
      const table = this.getQuantTable(params.quantTableId);
      if (!table) throw new CodecError("NOT_FOUND", `quant table ${params.quantTableId} not found`);
      if (!["zero", "edge", "reflect"].includes(params.padding)) {
        throw new CodecError("INVALID_PADDING", `unknown padding strategy ${params.padding}`);
      }
      const result = compress(image, table.steps, params.padding);
      const id = this.clock.uuid();
      this.db
        .prepare(
          `INSERT INTO artifacts
           (id,image_id,quant_table_id,padding,format_version,width,height,block_cols,block_rows,byte_length,blob,idempotency_key,created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          id,
          params.imageId,
          params.quantTableId,
          params.padding,
          result.formatVersion,
          result.width,
          result.height,
          result.blockCols,
          result.blockRows,
          result.byteLength,
          result.blob,
          params.idempotencyKey,
          this.clock.now(),
        );
      const row = this.db.prepare("SELECT * FROM artifacts WHERE id = ?").get(id) as unknown as ArtifactRow;
      return { artifact: rowToArtifact(row), replayed: false };
    });
  }

  getArtifact(id: string): CompressedArtifact | null {
    const row = this.db.prepare("SELECT * FROM artifacts WHERE id = ?").get(id) as unknown as ArtifactRow | undefined;
    return row ? rowToArtifact(row) : null;
  }

  listArtifacts(limit: number, offset: number, imageId?: string): Page<CompressedArtifact> {
    const total = imageId
      ? (this.db.prepare("SELECT COUNT(*) AS c FROM artifacts WHERE image_id=?").get(imageId) as { c: number }).c
      : (this.db.prepare("SELECT COUNT(*) AS c FROM artifacts").get() as { c: number }).c;
    const items = imageId
      ? (this.db
          .prepare("SELECT * FROM artifacts WHERE image_id=? ORDER BY created_at,id LIMIT ? OFFSET ?")
          .all(imageId, limit, offset) as unknown as ArtifactRow[]).map(rowToArtifact)
      : (this.db
          .prepare("SELECT * FROM artifacts ORDER BY created_at,id LIMIT ? OFFSET ?")
          .all(limit, offset) as unknown as ArtifactRow[]).map(rowToArtifact);
    return { items, total, limit, offset };
  }

  /** Decode strictly from the stored blob; original pixels are not consulted. */
  decompress(artifactId: string): GrayImage {
    const artifact = this.getArtifact(artifactId);
    if (!artifact) throw new CodecError("NOT_FOUND", `artifact ${artifactId} not found`);
    return decompress(Buffer.from(artifact.blob));
  }

  /** Compute (and cache) an error report over valid original pixels. */
  getOrCreateReport(artifactId: string) {
    const artifact = this.getArtifact(artifactId);
    if (!artifact) throw new CodecError("NOT_FOUND", `artifact ${artifactId} not found`);
    const existing = this.db.prepare("SELECT * FROM reports WHERE artifact_id=?").get(artifactId) as
      | ReportRow
      | undefined;
    if (existing) return rowToReport(existing);

    return withTransaction(this.db, () => {
      const image = this.getImage(artifact.imageId);
      if (!image) throw new CodecError("NOT_FOUND", `source image ${artifact.imageId} not found`);
      const reconstructed = decompress(Buffer.from(artifact.blob));
      const report = computeError(image, reconstructed, artifactId);
      this.db
        .prepare(
          `INSERT INTO reports (artifact_id,mse,psnr_db,psnr_state,max_error,error_matrix,created_at)
           VALUES (?,?,?,?,?,?,?)`,
        )
        .run(
          artifactId,
          report.mse,
          report.psnrDb,
          report.psnrState,
          report.maxError,
          Buffer.from(report.errorMatrix.map((e) => (e < 0 ? e + 512 : e))),
          this.clock.now(),
        );
      return report;
    });
  }

  /** Export the signed per-pixel error matrix. */
  exportErrorMatrix(artifactId: string): { width: number; height: number; errors: number[] } {
    const artifact = this.getArtifact(artifactId);
    if (!artifact) throw new CodecError("NOT_FOUND", `artifact ${artifactId} not found`);
    const image = this.getImage(artifact.imageId);
    if (!image) throw new CodecError("NOT_FOUND", `source image ${artifact.imageId} not found`);
    const reconstructed = decompress(Buffer.from(artifact.blob));
    return {
      width: image.width,
      height: image.height,
      errors: computeError(image, reconstructed, artifactId).errorMatrix,
    };
  }
}

interface ArtifactRow {
  id: string;
  image_id: string;
  quant_table_id: number;
  padding: PaddingStrategy;
  format_version: number;
  width: number;
  height: number;
  block_cols: number;
  block_rows: number;
  byte_length: number;
  blob: Buffer;
  created_at: string;
}

interface ReportRow {
  artifact_id: string;
  mse: number;
  psnr_db: number | null;
  psnr_state: "finite" | "infinite";
  max_error: number;
  error_matrix: Buffer;
}

function rowToArtifact(row: ArtifactRow): CompressedArtifact {
  return {
    id: row.id,
    imageId: row.image_id,
    quantTableId: Number(row.quant_table_id),
    padding: row.padding,
    formatVersion: row.format_version,
    width: row.width,
    height: row.height,
    blockCols: row.block_cols,
    blockRows: row.block_rows,
    byteLength: row.byte_length,
    blob: Buffer.from(row.blob),
    createdAt: row.created_at,
  };
}

function rowToReport(row: ReportRow) {
  return {
    artifactId: row.artifact_id,
    mse: row.mse,
    psnrDb: row.psnr_db,
    psnrState: row.psnr_state,
    maxError: row.max_error,
  };
}
