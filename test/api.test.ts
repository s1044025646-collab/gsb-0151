import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startServer } from "../src/api/server.js";
import { allFixtures } from "../src/core/fixtures.js";
import type { StartedServer } from "../src/api/server.js";

const dir = join(tmpdir(), `gbc-api-${process.pid}`);
let server: StartedServer;

before(async () => {
  rmSync(dir, { recursive: true, force: true });
  server = await startServer(join(dir, "api.sqlite"), 0);
});

after(async () => {
  await server.close();
});

async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(`http://127.0.0.1:${server.port}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json();
  return { status: res.status, json };
}

test("end to end: import, quant table, compress (idempotent), pixels, report, errors", async () => {
  const img = allFixtures().gradient!;
  const imp = await call("POST", "/images", { name: "grad", ...img });
  assert.ok([200, 201].includes(imp.status));
  const imageId = imp.json.id;

  const qt = await call("POST", "/quant-tables", { name: "s10", preset: "scaled", strength: 10 });
  const tableId = qt.json.id;

  const payload = { imageId, quantTableId: tableId, padding: "reflect", idempotencyKey: "e2e-1" };
  const c1 = await call("POST", "/artifacts", payload);
  assert.equal(c1.status, 201);
  assert.equal(c1.json.replayed, false);
  assert.ok(typeof c1.json.byteLength === "number");
  const c2 = await call("POST", "/artifacts", payload);
  assert.equal(c2.status, 200);
  assert.equal(c2.json.replayed, true);
  assert.equal(c2.json.id, c1.json.id);

  const pixels = await call("GET", `/artifacts/${c1.json.id}/pixels`);
  assert.equal(pixels.json.width, img.width);
  assert.equal(pixels.json.pixels.length, img.width * img.height);

  const report = await call("GET", `/artifacts/${c1.json.id}/report`);
  assert.ok("mse" in report.json);
  assert.ok(report.json.psnrState === "finite" || report.json.psnrState === "infinite");

  const errors = await call("GET", `/artifacts/${c1.json.id}/errors`);
  assert.equal(errors.json.errors.length, img.width * img.height);
});

test("validation errors have explicit codes", async () => {
  const bad = await call("POST", "/images", { name: "x", width: 2, height: 2, pixels: [1, 2, 3] });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error.code, "INVALID_DIMENSIONS");

  const missing = await call("POST", "/artifacts", { imageId: "x" });
  assert.equal(missing.status, 400);
  assert.equal(missing.json.error.code, "VALIDATION");

  const notFound = await call("GET", "/artifacts/does-not-exist/pixels");
  assert.equal(notFound.status, 404);
  assert.equal(notFound.json.error.code, "NOT_FOUND");

  const badPad = await call("POST", "/images", { name: "x", width: 1, height: 1, pixels: [999] });
  assert.equal(badPad.json.error.code, "INVALID_PIXEL_VALUE");
});

test("pagination metadata is returned", async () => {
  const page = await call("GET", "/images?limit=1&offset=0");
  assert.equal(page.json.limit, 1);
  assert.equal(page.json.offset, 0);
  assert.ok(page.json.total >= 1);
  const badLimit = await call("GET", "/images?limit=999");
  assert.equal(badLimit.status, 400);
});

test("server binds only to loopback", () => {
  assert.match(JSON.stringify(server.server.address()), /127\.0\.0\.1/);
});
