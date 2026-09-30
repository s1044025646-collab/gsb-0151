#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { openDatabase } from "../storage/db.js";
import { Repository } from "../storage/repo.js";
import { compress } from "../core/codec.js";
import { readBlockCoefficients } from "../core/codec.js";
import { computeError, formatPsnr } from "../core/metrics.js";
import { allFixtures } from "../core/fixtures.js";
import { scaledSteps, uniformSteps } from "../core/quantize.js";
import { CodecError } from "../core/errors.js";

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1] !== undefined) return process.argv[i + 1]!;
  if (fallback !== undefined) return fallback;
  throw new CodecError("VALIDATION", `missing required --${name}`);
}

function stateLine(repo: Repository): string {
  const images = (repo.listImages(1, 0).total);
  const tables = repo.listQuantTables(1, 0).total;
  const artifacts = repo.listArtifacts(1, 0).total;
  return `state before: images=${images} quantTables=${tables} artifacts=${artifacts}`;
}

async function main(): Promise<void> {
  const command = process.argv[2];
  const dbFile = resolve(arg("db", join(process.cwd(), "tmp", "gbc.sqlite")));
  mkdirSync(join(process.cwd(), "tmp"), { recursive: true });
  const db = openDatabase(dbFile);
  const repo = new Repository(db);

  try {
    switch (command) {
      case "import": {
        console.log(stateLine(repo));
        const source = arg("source", "all-fixtures");
        let images: Record<string, { width: number; height: number; pixels: number[] }>;
        if (source === "all-fixtures") images = allFixtures();
        else images = JSON.parse(readFileSync(resolve(source), "utf8"));
        for (const [name, img] of Object.entries(images)) {
          const result = repo.importImage(name, img);
          console.log(`imported ${name} ${img.width}x${img.height} -> id=${result.id}${result.reused ? " (deduplicated)" : ""}`);
        }
        console.log(stateLine(repo));
        break;
      }
      case "quant-table": {
        console.log(stateLine(repo));
        const name = arg("name");
        const preset = arg("preset", "uniform");
        const steps = preset === "scaled" ? scaledSteps(Number(arg("strength", "50"))) : uniformSteps(Number(arg("step", "8")));
        const id = repo.createQuantTable({ name, steps });
        console.log(`quant table '${name}' preset=${preset} -> id=${id}`);
        console.log(stateLine(repo));
        break;
      }
      case "compress": {
        const imageId = arg("image");
        const tableId = Number(arg("table"));
        const padding = arg("padding", "reflect") as "zero" | "edge" | "reflect";
        const key = arg("key", `cli-${Date.now()}`);
        const before = repo.listArtifacts(1, 0).total;
        console.log(`state before: artifacts=${before}`);
        const { artifact, replayed } = repo.compress({ imageId, quantTableId: tableId, padding, idempotencyKey: key });
        const out = arg("out", join(process.cwd(), "tmp", `artifact-${artifact.id}.gbc`));
        writeFileSync(out, artifact.blob);
        console.log(
          `artifact id=${artifact.id} ${artifact.width}x${artifact.height} blocks=${artifact.blockCols}x${artifact.blockRows}` +
            ` serializedBytes=${artifact.byteLength} padding=${padding} v${artifact.formatVersion}${replayed ? " (replayed idempotent)" : ""}`,
        );
        console.log(`container written to ${out}`);
        console.log(`state after: artifacts=${repo.listArtifacts(1, 0).total}`);
        break;
      }
      case "decompress": {
        const artifactId = arg("artifact");
        const out = arg("out", join(process.cwd(), "tmp", `decoded-${artifactId}.json`));
        const image = repo.decompress(artifactId);
        writeFileSync(out, JSON.stringify(image));
        console.log(`decoded ${image.width}x${image.height} (${image.pixels.length} valid pixels, padding cropped) -> ${out}`);
        break;
      }
      case "coeffs": {
        const artifactId = arg("artifact");
        const bx = Number(arg("bx"));
        const by = Number(arg("by"));
        const artifact = repo.getArtifact(artifactId);
        if (!artifact) throw new CodecError("NOT_FOUND", "artifact not found");
        const coeffs = readBlockCoefficients(Buffer.from(artifact.blob), bx, by);
        console.log(`quantized coefficients of block (${bx},${by}) from container header/payload only:`);
        for (const row of coeffs) console.log(row.map((v) => String(v).padStart(6)).join(" "));
        break;
      }
      case "scan": {
        const imageId = arg("image");
        const padding = arg("padding", "reflect") as "zero" | "edge" | "reflect";
        const from = Number(arg("from", "1"));
        const to = Number(arg("to", "100"));
        const step = Number(arg("step", "10"));
        const image = repo.getImage(imageId);
        if (!image) throw new CodecError("NOT_FOUND", "image not found");
        console.log(`strength  bytes  mse         psnr                 maxErr`);
        for (let strength = from; strength <= to; strength += step) {
          const result = compress(image, scaledSteps(strength), padding);
          const { decompress } = await import("../core/codec.js");
          const decoded = decompress(result.blob);
          const report = computeError(image, decoded, "inline");
          console.log(
            [
              String(strength).padStart(8),
              String(result.byteLength).padStart(6),
              report.mse.toFixed(4).padStart(11),
              formatPsnr(report).padStart(20),
              String(report.maxError).padStart(6),
            ].join("  "),
          );
        }
        break;
      }
      case "errors": {
        const artifactId = arg("artifact");
        const out = arg("out", join(process.cwd(), "tmp", `errors-${artifactId}.json`));
        const matrix = repo.exportErrorMatrix(artifactId);
        writeFileSync(out, JSON.stringify(matrix));
        console.log(`error matrix ${matrix.width}x${matrix.height} (orig-minus-recon) -> ${out}`);
        break;
      }
      case "list": {
        const p = { limit: Number(arg("limit", "50")), offset: Number(arg("offset", "0")) };
        console.log("images", JSON.stringify(repo.listImages(p.limit, p.offset), null, 2));
        console.log("quant-tables", JSON.stringify(repo.listQuantTables(p.limit, p.offset), null, 2));
        console.log("artifacts", JSON.stringify(repo.listArtifacts(p.limit, p.offset).items.map(({ blob, ...r }) => r), null, 2));
        break;
      }
      default:
        console.log(
          [
            "usage: gbc <command> [options]",
            "commands:",
            "  import       --source <json|all-fixtures>",
            "  quant-table  --name <n> [--preset uniform --step 8 | --preset scaled --strength 50]",
            "  compress     --image <id> --table <id> [--padding reflect|zero|edge] [--key k] [--out f]",
            "  decompress   --artifact <id> [--out f]",
            "  coeffs       --artifact <id> --bx 0 --by 0",
            "  scan         --image <id> [--from 1 --to 100 --step 10] [--padding reflect]",
            "  errors       --artifact <id> [--out f]",
            "  list         [--limit 50 --offset 0]",
          ].join("\n"),
        );
    }
  } finally {
    db.close();
  }
}

main().catch((err: unknown) => {
  if (err instanceof CodecError) {
    console.error(`error [${err.code}]: ${err.message}`);
    process.exitCode = 1;
  } else {
    console.error(err);
    process.exitCode = 1;
  }
});
