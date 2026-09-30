import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { AddressInfo } from "node:net";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { openDatabase } from "../storage/db.js";
import { Repository } from "../storage/repo.js";
import { CodecError, errorStatusCode } from "../core/errors.js";
import { scaledSteps, uniformSteps } from "../core/quantize.js";

export interface ApiDeps {
  repo: Repository;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(json) });
  res.end(json);
}

function sendError(res: ServerResponse, err: unknown): void {
  if (err instanceof CodecError) {
    send(res, errorStatusCode(err.code), { error: { code: err.code, message: err.message, details: err.details ?? null } });
    return;
  }
  const message = err instanceof Error ? err.message : "internal error";
  send(res, 500, { error: { code: "INTERNAL", message } });
}

async function readJson(req: IncomingMessage, maxBytes = 20 * 1024 * 1024): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > maxBytes) throw new CodecError("VALIDATION", "request body too large");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw new CodecError("VALIDATION", "request body must be valid JSON");
  }
}

function requireFields(obj: Record<string, unknown>, fields: string[]): void {
  for (const f of fields) {
    if (obj[f] === undefined || obj[f] === null) {
      throw new CodecError("VALIDATION", `missing required field: ${f}`, { field: f });
    }
  }
}

function pagination(url: URL): { limit: number; offset: number } {
  const limit = Number(url.searchParams.get("limit") ?? "50");
  const offset = Number(url.searchParams.get("offset") ?? "0");
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    throw new CodecError("VALIDATION", "limit must be an integer in [1,200]");
  }
  if (!Number.isInteger(offset) || offset < 0) {
    throw new CodecError("VALIDATION", "offset must be a non-negative integer");
  }
  return { limit, offset };
}

export function createHandler(deps: ApiDeps) {
  const { repo } = deps;
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const path = url.pathname.replace(/\/+$/, "") || "/";
      const method = req.method ?? "GET";

      if (method === "GET" && path === "/health") {
        send(res, 200, { status: "ok" });
        return;
      }

      if (method === "POST" && path === "/images") {
        const body = await readJson(req);
        requireFields(body, ["name", "width", "height", "pixels"]);
        const result = repo.importImage(String(body.name), {
          width: Number(body.width),
          height: Number(body.height),
          pixels: body.pixels,
        });
        send(res, 200, result);
        return;
      }

      if (method === "GET" && path === "/images") {
        const p = pagination(url);
        send(res, 200, repo.listImages(p.limit, p.offset));
        return;
      }

      const imageMatch = path.match(/^\/images\/([^/]+)$/);
      if (method === "GET" && imageMatch) {
        const image = repo.getImage(imageMatch[1]!);
        if (!image) throw new CodecError("NOT_FOUND", "image not found");
        send(res, 200, image);
        return;
      }

      if (method === "POST" && path === "/quant-tables") {
        const body = await readJson(req);
        requireFields(body, ["name"]);
        let steps: number[];
        if (Array.isArray(body.steps)) steps = body.steps.map(Number);
        else if (body.preset === "uniform") steps = uniformSteps(Number(body.step ?? 8));
        else if (body.preset === "scaled") steps = scaledSteps(Number(body.strength ?? 50));
        else throw new CodecError("VALIDATION", "provide steps[] or preset 'uniform'|'scaled'");
        const id = repo.createQuantTable({ name: String(body.name), steps });
        send(res, 200, { id });
        return;
      }

      if (method === "GET" && path === "/quant-tables") {
        const p = pagination(url);
        send(res, 200, repo.listQuantTables(p.limit, p.offset));
        return;
      }

      const qtMatch = path.match(/^\/quant-tables\/(\d+)$/);
      if (method === "GET" && qtMatch) {
        const table = repo.getQuantTable(Number(qtMatch[1]));
        if (!table) throw new CodecError("NOT_FOUND", "quant table not found");
        send(res, 200, table);
        return;
      }

      if (method === "POST" && path === "/artifacts") {
        const body = await readJson(req);
        requireFields(body, ["imageId", "quantTableId", "padding", "idempotencyKey"]);
        const result = repo.compress({
          imageId: String(body.imageId),
          quantTableId: Number(body.quantTableId),
          padding: body.padding,
          idempotencyKey: String(body.idempotencyKey),
        });
        const { blob, ...meta } = result.artifact;
        send(res, result.replayed ? 200 : 201, {
          ...meta,
          replayed: result.replayed,
          blobBase64: blob.toString("base64"),
        });
        return;
      }

      if (method === "GET" && path === "/artifacts") {
        const p = pagination(url);
        const imageId = url.searchParams.get("imageId") ?? undefined;
        const page = repo.listArtifacts(p.limit, p.offset, imageId);
        send(res, 200, { ...page, items: page.items.map(({ blob, ...rest }) => rest) });
        return;
      }

      const pixelsMatch = path.match(/^\/artifacts\/([^/]+)\/pixels$/);
      if (method === "GET" && pixelsMatch) {
        send(res, 200, repo.decompress(pixelsMatch[1]!));
        return;
      }

      const artifactMatch = path.match(/^\/artifacts\/([^/]+)$/);
      if (method === "GET" && artifactMatch) {
        const artifact = repo.getArtifact(artifactMatch[1]!);
        if (!artifact) throw new CodecError("NOT_FOUND", "artifact not found");
        send(res, 200, { ...artifact, blob: artifact.blob.toString("base64") });
        return;
      }

      const reportMatch = path.match(/^\/artifacts\/([^/]+)\/report$/);
      if (method === "GET" && reportMatch) {
        const report = repo.getOrCreateReport(reportMatch[1]!);
        send(res, 200, { ...report, errorMatrix: undefined });
        return;
      }

      const errorsMatch = path.match(/^\/artifacts\/([^/]+)\/errors$/);
      if (method === "GET" && errorsMatch) {
        send(res, 200, repo.exportErrorMatrix(errorsMatch[1]!));
        return;
      }

      send(res, 404, { error: { code: "NOT_FOUND", message: `no route for ${method} ${path}` } });
    } catch (err) {
      sendError(res, err);
    }
  };
}

export interface StartedServer {
  server: Server;
  port: number;
  close: () => Promise<void>;
}

export async function startServer(dbFile?: string, preferredPort = 0): Promise<StartedServer> {
  const file = dbFile ?? join(process.cwd(), "tmp", "gbc.sqlite");
  const db = openDatabase(file);
  const repo = new Repository(db);
  const server = createServer(createHandler({ repo }));
  await new Promise<void>((resolve) => server.listen(preferredPort, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const close = () =>
    new Promise<void>((resolve, reject) =>
      server.close((err) => {
        db.close();
        err ? reject(err) : resolve();
      }),
    );
  return { server, port, close };
}

const invoked = process.argv[1] && /server\.(ts|js)$/.test(process.argv[1]);
if (invoked) {
  const portArg = Number(process.env.PORT ?? 0);
  startServer(undefined, Number.isInteger(portArg) ? portArg : 0).then(({ port }) => {
    writeFileSync(join(process.cwd(), "tmp", "gbc.pid"), `${process.pid}\n${port}\n`);
    console.log(`GBC API listening on http://127.0.0.1:${port}`);
  });
}
