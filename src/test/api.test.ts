import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { migrate } from '../db/database';
import { Repository } from '../db/repository';
import { FakeClock } from './helpers';
import { tempDbPath } from './helpers';
import { CodecService } from '../service/service';
import { createApiServer } from '../api/server';
import { randomImage } from '../core/fixtures';

async function start(): Promise<{ server: Server; base: string; db: DatabaseSync }> {
  const db = new DatabaseSync(tempDbPath());
  migrate(db);
  const service = new CodecService(new Repository(db, new FakeClock()));
  const server = createApiServer(service);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return { server, base: `http://127.0.0.1:${port}`, db };
}

async function call(base: string, path: string, init?: RequestInit & { json?: unknown }): Promise<{ status: number; body: any }> {
  const res = await fetch(base + path, {
    method: init?.method ?? (init?.json ? 'POST' : 'GET'),
    headers: init?.json ? { 'content-type': 'application/json' } : undefined,
    body: init?.json ? JSON.stringify(init.json) : undefined,
  });
  return { status: res.status, body: await res.json() };
}

test('API: full import, compress, decompress, blocks, errors, pagination flow', async () => {
  const { server, base, db } = await start();
  after(() => {
    server.close();
    db.close();
  });

  const health = await call(base, '/health');
  assert.equal(health.status, 200);

  const image = randomImage(13, 11, 17);
  const imported = await call(base, '/images', {
    json: { name: 'apiimg', width: 13, height: 11, pixels: Array.from(image.pixels) },
  });
  assert.equal(imported.status, 201);
  const imageId = imported.body.image.id;

  // idempotent resubmission
  const again = await call(base, '/images', {
    json: { name: 'apiimg', width: 13, height: 11, pixels: Array.from(image.pixels) },
  });
  assert.equal(again.status, 200);
  assert.equal(again.body.created, false);

  const compressed = await call(base, `/images/apiimg/artifacts`, { json: { step: 8, padding: 'edge' } });
  assert.equal(compressed.status, 201);
  assert.ok(typeof compressed.body.serializedBytes === 'number');
  assert.ok(compressed.body.report.validPixels === 143);
  const artifactId = compressed.body.artifactId as string;

  const list = await call(base, `/artifacts?imageId=${imageId}&page=1&pageSize=10`);
  assert.equal(list.status, 200);
  assert.equal(list.body.total >= 1, true);

  const rebuilt = await call(base, `/artifacts/${artifactId}`);
  assert.equal(rebuilt.status, 200);
  assert.equal(rebuilt.body.width, 13);
  assert.equal(rebuilt.body.pixels.length, 143);

  const block = await call(base, `/artifacts/${artifactId}/blocks/0,0`);
  assert.equal(block.status, 200);
  assert.equal(block.body.levels.length, 8);

  const errors = await call(base, `/artifacts/${artifactId}/errors`);
  assert.equal(errors.status, 200);
  assert.equal(errors.body.matrix.length, 143);

  const imagesPage = await call(base, '/images?page=1&pageSize=1');
  assert.equal(imagesPage.body.pageSize, 1);
  assert.ok(imagesPage.body.totalPages >= 1);
});

test('API: validation errors carry explicit codes', async () => {
  const { server, base, db } = await start();
  after(() => {
    server.close();
    db.close();
  });

  const badPixels = await call(base, '/images', { json: { name: 'bad', width: 2, height: 2, pixels: [0, 999, 0, 0] } });
  assert.equal(badPixels.status, 400);
  assert.equal(badPixels.body.error.code, 'INVALID_PIXEL');

  const missing = await call(base, '/images/nope/artifacts', { json: { step: 5, padding: 'zero' } });
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error.code, 'NOT_FOUND');

  const badPadding = await call(base, '/images', { json: { name: 'ok', width: 1, height: 1, pixels: [1] } });
  assert.equal(badPadding.status, 201);
  const bad = await call(base, '/images/ok/artifacts', { json: { step: 5, padding: 'weird' } });
  assert.equal(bad.body.error.code, 'INVALID_PADDING');

  const badStep = await call(base, '/images/ok/artifacts', { json: { step: 0, padding: 'zero' } });
  assert.equal(badStep.body.error.code, 'INVALID_QUANT_STEP');
});
