import { DatabaseSync } from 'node:sqlite';
import { Buffer } from 'node:buffer';
import { ClockLike } from './database';
import { CodecError } from '../core/errors';
import { GrayImage } from '../core/image';
import { ErrorReport } from '../core/codec';

export interface ImageRecord {
  id: string;
  name: string;
  width: number;
  height: number;
  pixels: Buffer;
  created_at: number;
}

export interface ArtifactRecord {
  id: string;
  image_id: string;
  image_version: number;
  padding: string;
  format_version: number;
  quant_json: string;
  quant_step_summary: number;
  container: Buffer;
  byte_length: number;
  created_at: number;
}

export interface Page<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export class Repository {
  constructor(private readonly db: DatabaseSync, private readonly clock: ClockLike) {}

  // Idempotent import: re-submitting the same name returns the existing record.
  importImage(name: string, image: GrayImage): { record: ImageRecord; created: boolean } {
    const existing = this.db.prepare('SELECT * FROM images WHERE name = ?').get(name) as
      | ImageRecord
      | undefined;
    if (existing) {
      if (existing.width !== image.width || existing.height !== image.height) {
        throw new CodecError('CONFLICT', `image name "${name}" already exists with different dimensions`);
      }
      return { record: existing, created: false };
    }
    const id = this.clock.randomUUID();
    const createdAt = this.clock.now();
    this.db
      .prepare(
        'INSERT INTO images (id, name, width, height, pixels, created_at) VALUES (?, ?, ?, ?, ?, ?)'
      )
      .run(id, name, image.width, image.height, Buffer.from(image.pixels), createdAt);
    return { record: this.getImageById(id), created: true };
  }

  getImageById(id: string): ImageRecord {
    const row = this.db.prepare('SELECT * FROM images WHERE id = ?').get(id) as ImageRecord | undefined;
    if (!row) throw new CodecError('NOT_FOUND', `image not found: ${id}`);
    return row;
  }

  getImageByName(name: string): ImageRecord {
    const row = this.db.prepare('SELECT * FROM images WHERE name = ?').get(name) as ImageRecord | undefined;
    if (!row) throw new CodecError('NOT_FOUND', `image not found: ${name}`);
    return row;
  }

  listImages(page: number, pageSize: number): Page<ImageRecord> {
    return this.paginate('SELECT * FROM images ORDER BY created_at, name', page, pageSize);
  }

  // Creates an artifact. Parameters map to distinct rows; repeating the same
  // (image, version, padding, quant table) is idempotent and returns the prior row.
  createArtifact(input: {
    imageId: string;
    imageVersion: number;
    padding: string;
    formatVersion: number;
    quant: number[];
    container: Buffer;
  }): { record: ArtifactRecord; created: boolean } {
    const image = this.getImageById(input.imageId);
    const quantJson = JSON.stringify(input.quant);
    const existing = this.db
      .prepare(
        'SELECT * FROM artifacts WHERE image_id = ? AND image_version = ? AND padding = ? AND quant_json = ?'
      )
      .get(input.imageId, input.imageVersion, input.padding, quantJson) as ArtifactRecord | undefined;
    if (existing) return { record: existing, created: false };

    const summary = input.quant.reduce((a, b) => a + b, 0) / input.quant.length;
    const id = this.clock.randomUUID();
    const createdAt = this.clock.now();
    this.db
      .prepare(
        `INSERT INTO artifacts
          (id, image_id, image_version, padding, format_version, quant_json, quant_step_summary, container, byte_length, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        image.id,
        input.imageVersion,
        input.padding,
        input.formatVersion,
        quantJson,
        summary,
        input.container,
        input.container.length,
        createdAt
      );
    return { record: this.getArtifact(id), created: true };
  }

  getArtifact(id: string): ArtifactRecord {
    const row = this.db.prepare('SELECT * FROM artifacts WHERE id = ?').get(id) as
      | ArtifactRecord
      | undefined;
    if (!row) throw new CodecError('NOT_FOUND', `artifact not found: ${id}`);
    return row;
  }

  listArtifacts(imageId: string | undefined, page: number, pageSize: number): Page<ArtifactRecord> {
    if (imageId) {
      this.getImageById(imageId);
      return this.paginate(
        'SELECT * FROM artifacts WHERE image_id = ? ORDER BY created_at, id',
        page,
        pageSize,
        imageId
      );
    }
    return this.paginate('SELECT * FROM artifacts ORDER BY created_at, id', page, pageSize);
  }

  saveReport(artifactId: string, report: ErrorReport): string {
    this.getArtifact(artifactId);
    const id = this.clock.randomUUID();
    this.db
      .prepare(
        `INSERT INTO reports (id, artifact_id, mse, psnr, psnr_state, max_error, error_matrix, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        artifactId,
        report.mse,
        report.psnr,
        report.psnrState,
        report.maxError,
        Buffer.from(report.errorMatrix.buffer, report.errorMatrix.byteOffset, report.errorMatrix.byteLength),
        this.clock.now()
      );
    return id;
  }

 getReport(id: string) {
    const row = this.db.prepare('SELECT * FROM reports WHERE id = ?').get(id) as
      | {
          id: string;
          artifact_id: string;
          mse: number;
          psnr: number | null;
          psnr_state: 'finite' | 'infinity';
          max_error: number;
          error_matrix: Buffer;
          created_at: number;
        }
      | undefined;
    if (!row) throw new CodecError('NOT_FOUND', `report not found: ${id}`);
    return row;
  }

  // Runs work in a transaction; any thrown error rolls the whole transaction back.
  transaction<T>(fn: () => T): T {
    const db = this.db;
    db.exec('BEGIN');
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  private paginate<T>(
    sql: string,
    page: number,
    pageSize: number,
    ...params: Array<null | number | bigint | string | Uint8Array>
  ): Page<T> {
    if (!Number.isInteger(page) || page < 1) {
      throw new CodecError('VALIDATION', 'page must be a positive integer');
    }
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 200) {
      throw new CodecError('VALIDATION', 'pageSize must be an integer in [1,200]');
    }
    const countSql = `SELECT COUNT(*) AS n FROM (${sql})`;
    const total = (this.db.prepare(countSql).get(...params) as { n: number }).n;
    const offset = (page - 1) * pageSize;
    const items = this.db
      .prepare(`${sql} LIMIT ? OFFSET ?`)
      .all(...params, pageSize, offset) as T[];
    return { items, page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) };
  }
}

export function recordToImage(record: ImageRecord): GrayImage {
  return { width: record.width, height: record.height, pixels: new Uint8Array(record.pixels) };
}
