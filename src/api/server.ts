import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { CodecService } from '../service/service';
import { CodecError } from '../core/errors';
import { uniformTable } from '../core/quantize';

interface JsonOut {
  status: number;
  body: unknown;
}

function parsePagination(url: URL): { page: number; pageSize: number } {
  const page = Number(url.searchParams.get('page') ?? '1');
  const pageSize = Number(url.searchParams.get('pageSize') ?? '20');
  return { page, pageSize };
}

function readJson(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw.length === 0 ? {} : JSON.parse(raw));
      } catch {
        reject(new CodecError('VALIDATION', 'request body must be valid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function resolveQuant(body: any): number[] {
  if (Array.isArray(body.quant)) return body.quant.map((q: unknown) => Number(q));
  if (typeof body.step === 'number') return uniformTable(body.step);
  throw new CodecError('VALIDATION', 'provide either "quant" (64 entries) or "step" (positive number)');
}

export function createApiServer(service: CodecService): Server {
  const server = createServer(async (req, res) => {
    try {
      const result = await route(service, req);
      sendJson(res, result.status, result.body);
    } catch (err) {
      if (err instanceof CodecError) {
        const status =
          err.code === 'NOT_FOUND'
            ? 404
            : err.code === 'CONFLICT'
            ? 409
            : 400;
        sendJson(res, status, { error: { code: err.code, message: err.message } });
      } else {
        sendJson(res, 500, { error: { code: 'INTERNAL', message: String((err as Error).message) } });
      }
    }
  });
  return server;
}

async function route(service: CodecService, req: IncomingMessage): Promise<JsonOut> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const method = req.method ?? 'GET';
  const parts = url.pathname.split('/').filter(Boolean);

  if (method === 'GET' && parts.length === 1 && parts[0] === 'health') {
    return { status: 200, body: { ok: true } };
  }

  if (method === 'POST' && parts.length === 1 && parts[0] === 'images') {
    const body = await readJson(req);
    const pixels: unknown = body.pixels;
    if (!Array.isArray(pixels)) throw new CodecError('VALIDATION', '"pixels" must be an array');
    const { record, created } = service.importImage(
      String(body.name),
      Number(body.width),
      Number(body.height),
      pixels as number[]
    );
    return {
      status: created ? 201 : 200,
      body: { created, image: { id: record.id, name: record.name, width: record.width, height: record.height } },
    };
  }

  if (method === 'GET' && parts.length === 1 && parts[0] === 'images') {
    const page = parsePagination(url);
    const result = service.repository.listImages(page.page, page.pageSize);
    return { status: 200, body: { ...result, items: result.items.map(stripPixels) } };
  }

  if (method === 'POST' && parts.length === 3 && parts[0] === 'images' && parts[2] === 'artifacts') {
    const body = await readJson(req);
    const padding = body.padding === 'edge' ? 'edge' : body.padding === 'zero' ? 'zero' : undefined;
    if (!padding) throw new CodecError('INVALID_PADDING', '"padding" must be "zero" or "edge"');
    const result = service.compress(parts[1], {
      padding,
      quant: resolveQuant(body),
      imageVersion: Number(body.imageVersion ?? 1),
    });
    return {
      status: result.created ? 201 : 200,
      body: {
        created: result.created,
        artifactId: result.artifactId,
        serializedBytes: result.bytes,
        report: serializeReport(result.report),
        reportId: result.reportId,
      },
    };
  }

  if (method === 'GET' && parts.length === 1 && parts[0] === 'artifacts') {
    const page = parsePagination(url);
    const imageId = url.searchParams.get('imageId') ?? undefined;
    const result = service.repository.listArtifacts(imageId, page.page, page.pageSize);
    return { status: 200, body: { ...result, items: result.items.map(stripContainer) } };
  }

  if (method === 'GET' && parts.length === 2 && parts[0] === 'artifacts') {
    const image = service.decompress(parts[1]);
    return { status: 200, body: { width: image.width, height: image.height, pixels: Array.from(image.pixels) } };
  }

  if (method === 'GET' && parts.length === 4 && parts[0] === 'artifacts' && parts[2] === 'blocks') {
    const [br, bc] = parts[3].split(',').map((v) => Number(v));
    const result = service.inspectBlock(parts[1], br, bc);
    return { status: 200, body: result };
  }

  if (method === 'GET' && parts.length === 3 && parts[0] === 'artifacts' && parts[2] === 'errors') {
    const result = service.errorMatrix(parts[1]);
    return { status: 200, body: { width: result.width, height: result.height, matrix: Array.from(result.matrix) } };
  }

  return { status: 404, body: { error: { code: 'NOT_FOUND', message: 'no such route' } } };
}

function serializeReport(report: import('../core/codec').ErrorReport) {
  return {
    mse: report.mse,
    psnr: report.psnr,
    psnrState: report.psnrState,
    maxError: report.maxError,
    validPixels: report.validPixels,
  };
}

function stripPixels(r: any) {
  return { id: r.id, name: r.name, width: r.width, height: r.height, createdAt: r.created_at };
}

function stripContainer(r: any) {
  return {
    id: r.id,
    imageId: r.image_id,
    imageVersion: r.image_version,
    padding: r.padding,
    formatVersion: r.format_version,
    byteLength: r.byte_length,
    quantStepSummary: r.quant_step_summary,
    createdAt: r.created_at,
  };
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}

export function listenLocal(server: Server, runDir: string): Promise<{ port: number; pidFile: string }> {
  return new Promise((resolve) => {
    mkdirSync(runDir, { recursive: true });
    // Port 0 lets the OS assign a free port; we bind to loopback only.
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      const pidFile = join(runDir, 'api.pid');
      writeFileSync(pidFile, JSON.stringify({ pid: process.pid, port, startedAt: new Date().toISOString() }));
      resolve({ port, pidFile });
    });
  });
}

