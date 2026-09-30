#!/usr/bin/env node
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openDatabase, defaultClock } from '../db/database';
import { Repository, recordToImage } from '../db/repository';
import { CodecService } from '../service/service';
import { uniformTable } from '../core/quantize';
import { standardFixtureSet } from '../core/fixtures';
import { decompressContainer, compareImages } from '../core/codec';
import { parseContainer } from '../core/container';
import { CodecError } from '../core/errors';

const root = process.cwd();
const dataDir = join(root, '.gbc', 'data');
const outDir = join(root, '.gbc', 'out');
mkdirSync(dataDir, { recursive: true });
mkdirSync(outDir, { recursive: true });

const db = openDatabase(join(dataDir, 'gbc.sqlite'));
const service = new CodecService(new Repository(db, defaultClock));

function usage(): void {
  console.log(
    [
      'Usage: cli <command> [options]',
      '  import-fixture <name>                 Import one of: ' + Object.keys(standardFixtureSet()).join(', '),
      '  import-raw <name> <width> <height> <file.json>',
      '  list [page] [pageSize]                List images',
      '  compress <image> <step> [zero|edge] [version]',
      '  artifacts <image> [page] [pageSize]',
      '  decompress <artifactId> [out.json]',
      '  block <artifactId> <row>,<col>        Show quantized coefficient block',
      '  scan <image> <from> <to> <delta> [zero|edge]',
      '  errors <artifactId> [out.json]       Export error matrix',
    ].join('\n')
  );
}

function header(title: string): void {
  console.log(`\n--- ${title} ---`);
}

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  try {
    switch (cmd) {
      case 'import-fixture': {
        const fixtures = standardFixtureSet();
        const image = fixtures[args[0]];
        if (!image) throw new CodecError('NOT_FOUND', 'unknown fixture: ' + args[0]);
        const before = service.repository.listImages(1, 200).total;
        const { record, created } = service.importImage(args[0], image.width, image.height, Array.from(image.pixels));
        header('import-fixture');
        console.log(`images before=${before} after=${service.repository.listImages(1, 200).total}`);
        console.log(`id=${record.id} ${record.width}x${record.height} created=${created}`);
        break;
      }
      case 'import-raw': {
        const [name, widthStr, heightStr, file] = args;
        const pixels = JSON.parse(readFileSync(file, 'utf8'));
        const { record, created } = service.importImage(name, Number(widthStr), Number(heightStr), pixels);
        header('import-raw');
        console.log(`id=${record.id} created=${created} ${record.width}x${record.height}`);
        break;
      }
      case 'list': {
        const page = service.repository.listImages(Number(args[0] ?? 1), Number(args[1] ?? 20));
        header('images');
        console.log(`page ${page.page}/${page.totalPages} total=${page.total}`);
        for (const item of page.items) console.log(`${item.id}  ${item.name}  ${item.width}x${item.height}`);
        break;
      }
      case 'compress': {
        const [name, stepStr, padding = 'zero', versionStr = '1'] = args;
        const step = Number(stepStr);
        header('compress before');
        const imageRecord = service.repository.getImageByName(name);
        console.log(`image=${name} ${imageRecord.width}x${imageRecord.height}`);
        const result = service.compress(name, {
          padding: padding as 'zero' | 'edge',
          quant: uniformTable(step),
          imageVersion: Number(versionStr),
        });
        header('compress after');
        console.log(`artifactId=${result.artifactId}`);
        console.log(`serializedBytes=${result.bytes} created=${result.created} (actual container bytes, not coefficient count)`);
        console.log(`MSE=${result.report.mse.toFixed(4)} maxError=${result.report.maxError} PSNR=${formatPsnr(result.report.psnr, result.report.psnrState)}`);
        break;
      }
      case 'artifacts': {
        const imageRecord = service.repository.getImageByName(args[0]);
        const page = service.repository.listArtifacts(imageRecord.id, Number(args[1] ?? 1), Number(args[2] ?? 20));
        header('artifacts');
        console.log(`total=${page.total}`);
        for (const a of page.items) {
          console.log(`${a.id} v${a.image_version} padding=${a.padding} fmt=${a.format_version} bytes=${a.byte_length} avgQ=${a.quant_step_summary}`);
        }
        break;
      }
      case 'decompress': {
        const artifact = service.repository.getArtifact(args[0]);
        header('decompress before');
        const parsed = parseContainer(Buffer.from(artifact.container));
        console.log(`container: ${parsed.width}x${parsed.height} padding=${parsed.padding} blocks=${parsed.blocks.length} bytes=${artifact.byte_length}`);
        const image = decompressContainer(Buffer.from(artifact.container));
        const original = recordToImage(service.repository.getImageById(artifact.image_id));
        const report = compareImages(original, image);
        header('decompress after');
        console.log(`rebuilt ${image.width}x${image.height}; MSE=${report.mse.toFixed(4)} maxError=${report.maxError} PSNR=${formatPsnr(report.psnr, report.psnrState)}`);
        if (args[1]) {
          writeFileSync(args[1], JSON.stringify({ width: image.width, height: image.height, pixels: Array.from(image.pixels) }));
          console.log('wrote ' + args[1]);
        }
        break;
      }
      case 'block': {
        const [id, coord] = args;
        const [row, col] = coord.split(',').map(Number);
        const result = service.inspectBlock(id, row, col);
        header(`block ${row},${col} (grid ${result.gridRows}x${result.gridCols})`);
        for (const line of result.levels) console.log(line.map((v) => String(v).padStart(5)).join(' '));
        break;
      }
      case 'scan': {
        const [name, from, to, delta, padding = 'zero'] = args;
        header(`scan strength ${from}..${to} step ${delta} padding=${padding}`);
        const rows = service.scanStrength(name, Number(from), Number(to), Number(delta), padding as 'zero' | 'edge');
        console.log('step  bytes   MSE       maxErr  PSNR');
        for (const row of rows) {
          console.log(
            `${String(row.step).padStart(4)}  ${String(row.bytes).padStart(5)}  ${row.report.mse.toFixed(4).padStart(8)}  ${String(row.report.maxError).padStart(6)}  ${formatPsnr(row.report.psnr, row.report.psnrState)}`
          );
        }
        break;
      }
      case 'errors': {
        const result = service.errorMatrix(args[0]);
        header('error matrix');
        console.log(`${result.width}x${result.height}`);
        for (let y = 0; y < result.height; y++) {
          console.log(Array.from(result.matrix.slice(y * result.width, (y + 1) * result.width)).map((v) => String(v).padStart(3)).join(' '));
        }
        if (args[1]) {
          writeFileSync(args[1], JSON.stringify({ width: result.width, height: result.height, matrix: Array.from(result.matrix) }));
          console.log('wrote ' + args[1]);
        }
        break;
      }
      default:
        usage();
    }
  } finally {
    db.close();
  }
}

function formatPsnr(psnr: number | null, state: 'finite' | 'infinity'): string {
  return state === 'infinity' || psnr === null ? 'Infinity (zero error)' : psnr.toFixed(4) + ' dB';
}

main().catch((err) => {
  if (err instanceof CodecError) {
    console.error(`error [${err.code}]: ${err.message}`);
  } else {
    console.error('error: ' + (err as Error).message);
  }
  db.close();
  process.exit(1);
});
