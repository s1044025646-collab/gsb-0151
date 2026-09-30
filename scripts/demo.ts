/**
 * Repeatable end-to-end demo. Uses the injected clock for deterministic IDs
 * and a dedicated database under ./tmp so it never touches other data.
 */
import { rmSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openDatabase } from "../src/storage/db.js";
import { Repository, type Clock } from "../src/storage/repo.js";
import { allFixtures } from "../src/core/fixtures.js";
import { scaledSteps, uniformSteps } from "../src/core/quantize.js";
import { decompress } from "../src/core/codec.js";
import { computeError, formatPsnr } from "../src/core/metrics.js";

const root = process.cwd();
const dir = join(root, "tmp");
const dbFile = join(dir, "demo.sqlite");
rmSync(dbFile, { force: true });
for (const ext of ["-wal", "-shm"]) if (existsSync(dbFile + ext)) rmSync(dbFile + ext);

let seq = 0;
const clock: Clock = { now: () => "2026-09-30T00:00:00.000Z", uuid: () => `demo-${(seq++).toString().padStart(3, "0")}` };
const db = openDatabase(dbFile);
const repo = new Repository(db, clock);

console.log("== GBC repeatable end-to-end demo ==");
for (const [name, img] of Object.entries(allFixtures())) {
  const { id } = repo.importImage(name, img);
  console.log(`image ${name.padEnd(12)} ${img.width}x${img.height} -> ${id}`);
}

const fineId = repo.createQuantTable({ name: "fine", steps: uniformSteps(0.5) });
const coarseId = repo.createQuantTable({ name: "coarse", steps: scaledSteps(80) });
console.log(`quant tables: fine=${fineId} coarse=${coarseId}`);

const images = repo.listImages(200, 0).items;
for (const meta of images) {
  const image = repo.getImage(meta.id)!;
  for (const [label, tableId] of [["fine", fineId], ["coarse", coarseId]] as const) {
    const { artifact, replayed } = repo.compress({
      imageId: meta.id,
      quantTableId: tableId,
      padding: "reflect",
      idempotencyKey: `demo-${meta.id}-${label}`,
    });
    const report = repo.getOrCreateReport(artifact.id);
    console.log(
      `${meta.name.padEnd(12)} ${label.padEnd(6)} bytes=${String(artifact.byteLength).padStart(4)} mse=${report.mse.toFixed(3).padStart(9)} psnr=${formatPsnr(report).padStart(18)} maxErr=${String(report.maxError).padStart(3)} replayed=${replayed}`,
    );
  }
}

// Idempotency demonstration on the random image
const randomMeta = images.find((i) => i.name === "random")!;
const replay = repo.compress({ imageId: randomMeta.id, quantTableId: coarseId, padding: "reflect", idempotencyKey: "demo-demo-005-coarse" });
console.log(`replayed coarse compress of random -> same id ${replay.artifact.id}, replayed=${replay.replayed}`);

// Offline, original-independent decode of the random image's coarse blob
const randomImage = repo.getImage(randomMeta.id)!;
const { artifact } = repo.compress({ imageId: randomMeta.id, quantTableId: coarseId, padding: "reflect", idempotencyKey: "demo-demo-005-coarse" });
const decoded = decompress(Buffer.from(artifact.blob));
const independent = computeError(randomImage, decoded, artifact.id);
writeFileSync(join(dir, "demo-errors.json"), JSON.stringify({
  width: independent.width,
  height: independent.height,
  errors: independent.errorMatrix,
}));
console.log(`container-only decode of ${artifact.id} verified; error matrix at tmp/demo-errors.json`);
console.log(`db file: ${dbFile}`);
db.close();
