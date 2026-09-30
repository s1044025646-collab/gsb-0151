import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export interface ClockLike {
  now(): number;
  randomUUID(): string;
}

export const defaultClock: ClockLike = {
  now: () => Date.now(),
  randomUUID: () => {
    // RFC4122 v4 without relying on global crypto availability quirks.
    const bytes = new Uint8Array(16);
    for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  },
};

// Migration is idempotent: guarded by IF NOT EXISTS and a schema_migrations table,
// so running it repeatedly is safe.
export function migrate(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS images (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      width INTEGER NOT NULL,
      height INTEGER NOT NULL,
      pixels BLOB NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS artifacts (
      id TEXT PRIMARY KEY,
      image_id TEXT NOT NULL REFERENCES images(id) ON DELETE CASCADE,
      image_version INTEGER NOT NULL,
      padding TEXT NOT NULL,
      format_version INTEGER NOT NULL,
      quant_json TEXT NOT NULL,
      quant_step_summary REAL NOT NULL,
      container BLOB NOT NULL,
      byte_length INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE(image_id, image_version, padding, quant_json)
    );
    CREATE TABLE IF NOT EXISTS reports (
      id TEXT PRIMARY KEY,
      artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
      mse REAL NOT NULL,
      psnr REAL,
      psnr_state TEXT NOT NULL,
      max_error INTEGER NOT NULL,
      error_matrix BLOB NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);
  const existing = db
    .prepare('SELECT COUNT(*) AS n FROM schema_migrations WHERE version = 1')
    .get() as { n: number };
  if (existing.n === 0) {
    db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (1, ?)').run(Date.now());
  }
}

export function openDatabase(filePath: string): DatabaseSync {
  mkdirSync(dirname(filePath), { recursive: true });
  const db = new DatabaseSync(filePath);
  db.exec('PRAGMA foreign_keys = ON;');
  migrate(db);
  return db;
}
