import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase, withTransaction } from "../src/storage/db.js";
import { Repository } from "../src/storage/repo.js";
import { allFixtures } from "../src/core/fixtures.js";
import { scaledSteps } from "../src/core/quantize.js";
import { CodecError } from "../src/core/errors.js";

const dir = join(tmpdir(), `gbc-repo-${process.pid}`);
const dbFile = join(dir, "test.sqlite");

let repo: Repository;

before(() => {
  rmSync(dir, { recursive: true, force: true });
  const db = openDatabase(dbFile);
  repo = new Repository(db);
});

test("migrations are repeatable", () => {
  const db = openDatabase(dbFile);
  openDatabase(dbFile);
  db.close();
});

test("import is content-deduplicated and independent artifacts persist", () => {
  const img = allFixtures().gradient!;
  const a = repo.importImage("grad", img);
  const b = repo.importImage("grad-again", img);
  assert.equal(a.id, b.id);
  assert.equal(b.reused, true);

  const table = repo.createQuantTable({ name: "s20", steps: scaledSteps(20) });
  const first = repo.compress({ imageId: a.id, quantTableId: table, padding: "reflect", idempotencyKey: "k1" });
  assert.equal(first.replayed, false);
  const replay = repo.compress({ imageId: a.id, quantTableId: table, padding: "reflect", idempotencyKey: "k1" });
  assert.equal(replay.replayed, true);
  assert.equal(replay.artifact.id, first.artifact.id);

  const otherPad = repo.compress({ imageId: a.id, quantTableId: table, padding: "zero", idempotencyKey: "k1" });
  assert.notEqual(otherPad.artifact.id, first.artifact.id);
  const otherKey = repo.compress({ imageId: a.id, quantTableId: table, padding: "reflect", idempotencyKey: "k2" });
  assert.notEqual(otherKey.artifact.id, first.artifact.id);
});

test("report metrics match direct recomputation and infinite state is stored", () => {
  const img = allFixtures().constantOdd!;
  const { id: imageId } = repo.importImage("const", img);
  const lossless = repo.createQuantTable({ name: "step1", steps: scaledSteps(1) });
  const { artifact } = repo.compress({ imageId, quantTableId: lossless, padding: "edge", idempotencyKey: "perfect" });
  const report = repo.getOrCreateReport(artifact.id);
  assert.equal(report.psnrState, "infinite");
  assert.equal(report.psnrDb, null);
  assert.equal(report.mse, 0);
  const matrix = repo.exportErrorMatrix(artifact.id);
  assert.equal(matrix.errors.length, img.width * img.height);
  assert.ok(matrix.errors.every((e) => e === 0));
});

test("transaction rolls back when a statement fails", () => {
  const db = openDatabase(dbFile);
  const before = (db.prepare("SELECT COUNT(*) c FROM images").get() as { c: number }).c;
  assert.throws(() =>
    withTransaction(db, () => {
      db.prepare(
        "INSERT INTO images (id,name,width,height,pixels,checksum,created_at) VALUES ('x','n',1,1,x'00','s','t')",
      ).run();
      throw new Error("boom");
    }),
  );
  const after = (db.prepare("SELECT COUNT(*) c FROM images").get() as { c: number }).c;
  assert.equal(after, before);
  db.close();
});

test("missing resources produce NOT_FOUND", () => {
  assert.throws(() => repo.decompress("nope"), (e: Error) => e instanceof CodecError && e.code === "NOT_FOUND");
  assert.throws(
    () => repo.compress({ imageId: "nope", quantTableId: 1, padding: "zero", idempotencyKey: "k" }),
    (e: Error) => e instanceof CodecError && e.code === "NOT_FOUND",
  );
});

test("pagination respects limit/offset", () => {
  const page = repo.listArtifacts(1, 0);
  assert.equal(page.items.length, 1);
  assert.ok(page.total >= 3);
  const second = repo.listArtifacts(1, 1);
  assert.notEqual(second.items[0]!.id, page.items[0]!.id);
});

test("state survives reopening the database (restart persistence)", () => {
  const db2 = openDatabase(dbFile);
  const reopened = new Repository(db2);
  const total = reopened.listArtifacts(1, 0).total;
  assert.ok(total >= 3);
  const any = reopened.listArtifacts(1, 0).items[0]!;
  const decoded = reopened.decompress(any.id);
  assert.equal(decoded.pixels.length, decoded.width * decoded.height);
  db2.close();
});

test("injected clock makes timestamps deterministic", () => {
  const dbFile2 = join(dir, "clock.sqlite");
  const db = openDatabase(dbFile2);
  let counter = 0;
  const fixedRepo = new Repository(db, {
    now: () => "2026-09-30T00:00:00.000Z",
    uuid: () => `fixed-${counter++}`,
  });
  const { id } = fixedRepo.importImage("g", allFixtures().checker!);
  assert.equal(id, "fixed-0");
  db.close();
});
