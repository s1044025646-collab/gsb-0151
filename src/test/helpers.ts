import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { migrate, ClockLike } from '../db/database';
import { Repository } from '../db/repository';

export function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gbc-test-'));
  return join(dir, 'test.sqlite');
}

export class FakeClock implements ClockLike {
  current = 1_700_000_000_000;
  private seq = 0;
  now(): number {
    return this.current;
  }
  advance(ms: number): void {
    this.current += ms;
  }
  randomUUID(): string {
    this.seq += 1;
    return `00000000-0000-4000-8000-${String(this.seq).padStart(12, '0')}`;
  }
}

export function makeRepo(path: string, clock?: FakeClock): { db: DatabaseSync; repo: Repository; clock: FakeClock } {
  const usedClock = clock ?? new FakeClock();
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON;');
  migrate(db);
  return { db, repo: new Repository(db, usedClock), clock: usedClock };
}
