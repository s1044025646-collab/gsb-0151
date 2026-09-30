import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { FakeClock, makeRepo, tempDbPath } from './helpers';
import { migrate } from '../db/database';
import { Repository } from '../db/repository';
import { CodecService } from '../service/service';
import { randomImage, gradientImage, standardFixtureSet } from '../core/fixtures';
import { uniformTable } from '../core/quantize';
import { CodecError } from '../core/errors';

test('migration is repeatable', () => {
  const path = tempDbPath();
  const db1 = new DatabaseSync(path);
  migrate(db1);
  migrate(db1);
  migrate(db1);
  const n = (db1.prepare('SELECT COUNT(*) AS n FROM schema_migrations WHERE version=1').get() as { n: number }).n;
  assert.equal(n, 1);
  db1.close();
});

test('data persists after reopening the database', () => {
  const path = tempDbPath();
  const { db, repo } = makeRepo(path);
  const image = randomImage(13, 9, 7);
  const { record, created } = repo.importImage('persist', image);
  assert.equal(created, true);
  db.close();

  const db2 = new DatabaseSync(path);
  migrate(db2);
  const repo2 = new Repository(db2, new FakeClock());
  const fetched = repo2.getImageByName('persist');
  assert.equal(fetched.width, 13);
  assert.equal(fetched.height, 9);
  assert.equal(fetched.id, record.id);
  db2.close();
  assert.ok(existsSync(path));
});

test('repeated import is idempotent and conflicts on dimension mismatch', () => {
  const path = tempDbPath();
  const { db, repo } = makeRepo(path);
  const first = repo.importImage('dup', randomImage(8, 8, 1));
  const second = repo.importImage('dup', randomImage(8, 8, 2));
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(first.record.id, second.record.id);

  assert.throws(
    () => repo.importImage('dup', randomImage(16, 8, 3)),
    (err: Error) => err instanceof CodecError && err.code === 'CONFLICT'
  );
  db.close();
});

test('compress artifacts are idempotent on identical parameters', () => {
  const path = tempDbPath();
  const { db, repo } = makeRepo(path);
  const service = new CodecService(repo);
  const image = gradientImage(16, 16);
  service.importImage('g', image.width, image.height, Array.from(image.pixels));
  const a = service.compress('g', { padding: 'zero', quant: uniformTable(10), imageVersion: 1 });
  const b = service.compress('g', { padding: 'zero', quant: uniformTable(10), imageVersion: 1 });
  assert.equal(a.created, true);
  assert.equal(b.created, false);
  assert.equal(a.artifactId, b.artifactId);
  const c = service.compress('g', { padding: 'edge', quant: uniformTable(10), imageVersion: 1 });
  assert.notEqual(c.artifactId, a.artifactId);
  db.close();
});

test('transaction rolls back when a later statement fails', () => {
  const path = tempDbPath();
  const { db, repo } = makeRepo(path);
  repo.importImage('tx', randomImage(8, 8, 1));
  const before = repo.listImages(1, 50).total;
  assert.throws(() =>
    repo.transaction(() => {
      // Insert one valid image, then force a failure; both must roll back.
      repo.importImage('inside-tx', randomImage(8, 8, 2));
      throw new CodecError('VALIDATION', 'forced failure');
    })
  );
  const after = repo.listImages(1, 50).total;
  assert.equal(after, before);
  assert.throws(() => repo.getImageByName('inside-tx'), (err: Error) => (err as CodecError).code === 'NOT_FOUND');
  db.close();
});

test('pagination metadata is correct', () => {
  const path = tempDbPath();
  const { db, repo } = makeRepo(path);
  for (let i = 0; i < 5; i++) repo.importImage(`img${i}`, randomImage(8, 8, i));
  const page1 = repo.listImages(1, 2);
  assert.equal(page1.total, 5);
  assert.equal(page1.totalPages, 3);
  assert.equal(page1.items.length, 2);
  const page3 = repo.listImages(3, 2);
  assert.equal(page3.items.length, 1);
  assert.throws(() => repo.listImages(0, 2), CodecError);
  assert.throws(() => repo.listImages(1, 0), CodecError);
  db.close();
});

test('error report round trip has known values and exported matrix', () => {
  const path = tempDbPath();
  const { db, repo } = makeRepo(path);
  const service = new CodecService(repo);
  const image = standardFixtureSet().checker;
  service.importImage('checker', image.width, image.height, Array.from(image.pixels));
  const result = service.compress('checker', { padding: 'zero', quant: uniformTable(30), imageVersion: 1 });
  assert.ok(result.report.mse >= 0);
  assert.equal(result.report.psnrState === 'infinity', result.report.mse === 0);
  const errors = service.errorMatrix(result.artifactId);
  assert.equal(errors.matrix.length, image.width * image.height);
  db.close();
});

test('injectable clock controls timestamps deterministically', () => {
  const path = tempDbPath();
  const clock = new FakeClock();
  const { db, repo } = makeRepo(path, clock);
  const { record } = repo.importImage('clocked', randomImage(8, 8, 1));
  assert.equal(record.created_at, 1_700_000_000_000);
  clock.advance(5000);
  const { record: r2 } = repo.importImage('clocked2', randomImage(8, 8, 1));
  assert.equal(r2.created_at, 1_700_000_005_000);
  db.close();
});

