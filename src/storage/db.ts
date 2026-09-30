import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Open the database and run idempotent migrations.
 * Safe to call repeatedly: every statement uses IF NOT EXISTS and the
 * user_version pragma guards future schema changes.
 */
export function openDatabase(file: string): DatabaseSync {
  mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode=WAL;");
  db.exec("PRAGMA foreign_keys=ON;");
  migrate(db);
  return db;
}

export function migrate(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS images (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      width       INTEGER NOT NULL,
      height      INTEGER NOT NULL,
      pixels      BLOB NOT NULL,
      checksum    TEXT NOT NULL,
      created_at  TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS quant_tables (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT NOT NULL UNIQUE,
      steps       BLOB NOT NULL,
      created_at  TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS artifacts (
      id              TEXT PRIMARY KEY,
      image_id        TEXT NOT NULL REFERENCES images(id),
      quant_table_id  INTEGER NOT NULL REFERENCES quant_tables(id),
      padding         TEXT NOT NULL,
      format_version  INTEGER NOT NULL,
      width           INTEGER NOT NULL,
      height          INTEGER NOT NULL,
      block_cols      INTEGER NOT NULL,
      block_rows      INTEGER NOT NULL,
      byte_length     INTEGER NOT NULL,
      blob            BLOB NOT NULL,
      idempotency_key TEXT NOT NULL,
      created_at      TEXT NOT NULL,
      UNIQUE(image_id, quant_table_id, padding, idempotency_key)
    );

    CREATE TABLE IF NOT EXISTS reports (
      artifact_id   TEXT PRIMARY KEY REFERENCES artifacts(id),
      mse           REAL NOT NULL,
      psnr_db       REAL,
      psnr_state    TEXT NOT NULL CHECK (psnr_state IN ('finite','infinite')),
      max_error     INTEGER NOT NULL,
      error_matrix  BLOB NOT NULL,
      created_at    TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_artifacts_image ON artifacts(image_id);
    CREATE INDEX IF NOT EXISTS idx_reports_artifact ON reports(artifact_id);
  `);
  db.exec("PRAGMA user_version=1;");
}

/** Run `fn` in a transaction, rolling back on thrown errors. */
export function withTransaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
