import { Repository, recordToImage } from '../db/repository';
import { BLOCK } from '../core/dct';
import { compressImage, compareImages, decompressContainer, ErrorReport } from '../core/codec';
import { FORMAT_VERSION } from '../core/container';
import { extractCenteredBlock, GrayImage, makeImage, PaddingStrategy } from '../core/image';
import { quantizeBlock, QuantTable, validateQuantTable } from '../core/quantize';
import { parseContainer } from '../core/container';
import { fail } from '../core/errors';

export interface CompressOptions {
  padding: PaddingStrategy;
  quant: QuantTable;
  imageVersion: number;
}

export class CodecService {
  constructor(private readonly repo: Repository) {}

  get repository(): Repository {
    return this.repo;
  }

  importImage(name: string, width: number, height: number, pixels: number[]) {
    const image = makeImage(width, height, pixels);
    return this.repo.importImage(name, image);
  }

  compress(imageName: string, options: CompressOptions): {
    artifactId: string;
    bytes: number;
    created: boolean;
    report: ErrorReport;
    reportId: string;
  } {
    if (options.imageVersion < 1 || !Number.isInteger(options.imageVersion)) {
      fail('VALIDATION', 'imageVersion must be a positive integer');
    }
    validateQuantTable(options.quant);
    if (options.padding !== 'zero' && options.padding !== 'edge') {
      fail('INVALID_PADDING', "padding must be 'zero' or 'edge'");
    }
    const imageRecord = this.repo.getImageByName(imageName);
    const image = recordToImage(imageRecord);
    const { container, bytes } = compressImage(image, options.quant, options.padding);

    return this.repo.transaction(() => {
      const { record, created } = this.repo.createArtifact({
        imageId: imageRecord.id,
        imageVersion: options.imageVersion,
        padding: options.padding,
        formatVersion: FORMAT_VERSION,
        quant: options.quant,
        container,
      });
      const rebuilt = decompressContainer(Buffer.from(record.container));
      const report = compareImages(image, rebuilt);
      const reportId = this.repo.saveReport(record.id, report);
      return { artifactId: record.id, bytes: record.byte_length ?? bytes, created, report, reportId };
    });
  }

  decompress(artifactId: string): GrayImage {
    const artifact = this.repo.getArtifact(artifactId);
    return decompressContainer(Buffer.from(artifact.container));
  }

  // Inspect quantized coefficients of one block of an artifact; decoding uses
  // only the stored container.
  inspectBlock(artifactId: string, blockRow: number, blockCol: number) {
    const artifact = this.repo.getArtifact(artifactId);
    const parsed = parseContainer(Buffer.from(artifact.container));
    const cols = Math.ceil(parsed.width / BLOCK);
    const rows = Math.ceil(parsed.height / BLOCK);
    if (
      !Number.isInteger(blockRow) ||
      !Number.isInteger(blockCol) ||
      blockRow < 0 ||
      blockCol < 0 ||
      blockRow >= rows ||
      blockCol >= cols
    ) {
      fail('VALIDATION', `block coordinates out of range (grid ${rows}x${cols})`);
    }
    return {
      blockRow,
      blockCol,
      gridRows: rows,
      gridCols: cols,
      levels: parsed.blocks[blockRow * cols + blockCol],
    };
  }

  // Compress an image across a range of uniform quant strengths.
  scanStrength(
    imageName: string,
    fromStep: number,
    toStep: number,
    stepDelta: number,
    padding: PaddingStrategy
  ): Array<{ step: number; artifactId: string; bytes: number; report: ErrorReport }> {
    if (!(fromStep >= 1) || !(toStep >= fromStep) || !(stepDelta > 0)) {
      fail('VALIDATION', 'require 1 <= fromStep <= toStep and stepDelta > 0');
    }
    const results = [];
    let version = 1;
    for (let q = fromStep; q <= toStep; q += stepDelta) {
      const result = this.compress(imageName, {
        padding,
        quant: new Array<number>(64).fill(Math.round(q)),
        imageVersion: version++,
      });
      results.push({ step: Math.round(q), artifactId: result.artifactId, bytes: result.bytes, report: result.report });
    }
    return results;
  }

  errorMatrix(artifactId: string): { width: number; height: number; matrix: Int32Array } {
    const artifact = this.repo.getArtifact(artifactId);
    const imageRecord = this.repo.getImageById(artifact.image_id);
    const original = recordToImage(imageRecord);
    const rebuilt = this.decompress(artifactId);
    const report = compareImages(original, rebuilt);
    return { width: report.width, height: report.height, matrix: report.errorMatrix };
  }
}

export { quantizeBlock, extractCenteredBlock };
