import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { migrate } from '../db/database';
import { Repository } from '../db/repository';
import { FakeClock } from '../test/helpers';
import { CodecService } from '../service/service';
import { standardFixtureSet } from '../core/fixtures';
import { uniformTable } from '../core/quantize';
import { decompressContainer } from '../core/codec';

const demoDir = join(process.cwd(), '.gbc', 'demo');
rmSync(demoDir, { recursive: true, force: true });
mkdirSync(demoDir, { recursive: true });

const dbPath = join(demoDir, 'demo.sqlite');
const db = new DatabaseSync(dbPath);
migrate(db);
const service = new CodecService(new Repository(db, new FakeClock()));

console.log('=== GBC1 reproducible end-to-end demo (custom container, NOT JPEG) ===');
const fixtures = standardFixtureSet();

for (const [name, image] of Object.entries(fixtures)) {
  service.importImage(name, image.width, image.height, Array.from(image.pixels));
  console.log(`imported ${name.padEnd(11)} ${image.width}x${image.height}  pixels=${image.pixels.length}`);
}

console.log('\n=== compress gradient (odd 13x8) across quant strengths, edge padding ===');
const scan = service.scanStrength('odd_width', 1, 25, 4, 'edge');
for (const row of scan) {
  const psnr = row.report.psnrState === 'infinity' ? 'Infinity dB' : row.report.psnr!.toFixed(2) + ' dB';
  console.log(
    `step=${String(row.step).padStart(2)}  bytes=${String(row.bytes).padStart(4)}  mse=${row.report.mse.toFixed(3).padStart(8)}  maxErr=${String(row.report.maxError).padStart(3)}  psnr=${psnr}`
  );
}

console.log('\n=== zero-quantization-loss round trip (step=1) on checker 16x16 ===');
const lossless = service.compress('checker', { padding: 'zero', quant: uniformTable(1), imageVersion: 1 });
console.log(`serializedBytes=${lossless.bytes} mse=${lossless.report.mse} psnr=${lossless.report.psnrState}`);

console.log('\n=== independent decode from stored container bytes only ===');
const artifact = service.repository.getArtifact(lossless.artifactId);
const decoded = decompressContainer(Buffer.from(artifact.container));
console.log(`decoded ${decoded.width}x${decoded.height} using header+payload; padding cropped`);

console.log('\n=== idempotency: repeat same parameters ===');
const repeat = service.compress('checker', { padding: 'zero', quant: uniformTable(1), imageVersion: 1 });
console.log(`first.created=${lossless.created} repeat.created=${repeat.created} sameId=${repeat.artifactId === lossless.artifactId}`);

console.log('\nDemo database at ' + dbPath + ' (delete .gbc to reset).');
db.close();
