# grayblock-codec (GBC1)

A local, dependency-light backend for **8-bit grayscale block compression and rebuild
error analysis**, written in TypeScript on Node.js with SQLite. It implements its own
orthonormal 8x8 DCT, quantization, zig-zag scan and zero-run coding, and stores
artifacts in a **self-designed public container format `GBC1`**.

> This project does **not** implement or claim compatibility with JPEG. No third-party
> image encoders are used. There is no web UI — only an HTTP API, a CLI, synthetic
> fixtures and automated tests.

## Implemented rules

- **Input**: 8-bit grayscale matrices only (`0..255`, validated).
- **Transform**: orthonormal DCT-II with level centering (`pixel - 128`) and inverse
  DCT-III. Orthonormality preserves energy (Parseval), asserted in tests.
- **Quantization**: divide by positive per-coefficient steps, integer levels via
  **half-away-from-zero** rounding (explicit for negatives); multiply back on decode.
- **Entropy coding**: standard zig-zag scan, 4-bit run-length coding of AC zeros,
  zig-zag signed varints, and one trailing EOB token for terminal zero runs.
- **Padding**: blocks are 8x8; two strategies are fully stored in every artifact —
  `zero` (128/zero-centered fill) and `edge` (bottom/right edge replication). The
  original width/height are saved; padding is **always cropped** after IDCT.
- **Pixel clipping**: reconstructed pixels are rounded and clipped to `0..255`.
- **Metrics**: MSE, PSNR and max absolute error use **original valid pixels only**
  (padding never counted). Zero MSE is reported as explicit state `psnrState:
  "infinity"` with `psnr: null`.
- **Size**: the reported compressed size is the **actual serialized byte count** of
  the container, never the number of nonzero coefficients.
- **Independent decoding**: decompression reads only the file header + payload
  (magic, version, original size, padding code, 64 quant steps, block tokens). It
  never touches the source image.
- **Rejected inputs** with explicit error codes: non-positive quant steps
  (`INVALID_QUANT_STEP`), oversized/non-integer dimensions (`DIMENSION_OVERFLOW`),
  invalid pixels (`INVALID_PIXEL`), bad magic (`BAD_MAGIC`), unknown version
  (`UNSUPPORTED_VERSION`), illegal runs (`INVALID_RUN`), truncated payload / trailing
  bytes (`TRUNCATED_PAYLOAD`), corrupt header (`CORRUPT_HEADER`).

## Container layout (GBC1, version 1)

| field | encoding |
| --- | --- |
| magic | ASCII `GBC1` |
| version | u8 = 1 |
| width, height | u16 LE (original, padded crop reference) |
| padding | u8 (`0` zero, `1` edge) |
| reserved | u8 = 0 |
| quant table | 64 x u16 LE, natural row-major order |
| block count | varint (`ceil(w/8)*ceil(h/8)`) |
| per block | token count varint, then tokens of `run:u8(0..15)` + signed value varint; DC is first token with run 0 |

Distinct parameters (image version, quant table, padding) create independent
artifacts; format version, padding and quant table travel inside the file.

## Persistence and behavior

- SQLite via Node's built-in `node:sqlite` — no native build step.
- Migrations are repeatable (`schema_migrations` + `IF NOT EXISTS`).
- Repeated imports/artifacts are **idempotent** (unique keys); conflicts are reported.
- Artifact creation + report writing run in a transaction with rollback on failure.
- Clock and UUID source are injectable for deterministic tests.
- All data/temp files stay under `./.gbc` in this project.
- The HTTP server binds **127.0.0.1 only** and uses **OS-assigned free port 0**.

## Requirements

- Node.js >= 22 (built-in `node:sqlite`; developed on Node 25)
- npm (ships with Node)

## Install

```powershell
npm install
```

## Test

```powershell
npm test
```

Covers: no-quantization transform round trip, Parseval energy identity, zig-zag,
RLE encode/restore and illegal runs, container-independent decode, known quantization
errors, padding/crop on non-multiple-of-eight sizes, corrupted/truncated payloads,
pagination, idempotency, transaction rollback, restart persistence and the full HTTP
flow.

## Reproducible demo

```powershell
npm run demo
```

Imports constant/gradient/checker/pulse/random and odd-sized fixtures, scans quant
strengths, shows real serialized sizes, MSE/PSNR/max-error, independent decode and
idempotency. Uses a fresh `.gbc/demo` directory each run.

## API: start and stop

Start (binds `127.0.0.1`, prints the assigned port, writes `.gbc/run/api.pid`):

```powershell
npm start
```

Stop (sends SIGTERM to the pid recorded for **this** project, removes the pid file):

```powershell
npm run stop
```

### Endpoints

- `GET  /health`
- `POST /images` `{name,width,height,pixels:number[]}` (idempotent on `name`)
- `GET  /images?page=1&pageSize=20`
- `POST /images/:name/artifacts` `{padding:"zero"|"edge", imageVersion?:number, step?:number}` or `{quant:number[64]}`
- `GET  /artifacts?imageId=...&page=1&pageSize=20`
- `GET  /artifacts/:id` (rebuilt pixels, decoded from the container only)
- `GET  /artifacts/:id/blocks/:row,:col` (quantized coefficient levels)
- `GET  /artifacts/:id/errors` (absolute error matrix over valid pixels)

Errors return `{ "error": { "code", "message" } }` with HTTP 400/404/409.

## CLI

```powershell
npm run cli -- import-fixture constant|gradient|checker|pulse|random|odd_width|odd_height|odd_both
npm run cli -- import-raw <name> <width> <height> <pixels.json>
npm run cli -- list [page] [pageSize]
npm run cli -- compress <image> <step> [zero|edge] [imageVersion]
npm run cli -- artifacts <image>
npm run cli -- decompress <artifactId> [out.json]
npm run cli -- block <artifactId> <row>,<col>
npm run cli -- scan <image> <from> <to> <delta> [zero|edge]
npm run cli -- errors <artifactId> [out.json]
```

The CLI prints before/after state for import and compression, and always reports the
actual container byte count.

## Cleanup

All runtime state lives in `./.gbc` (`data/`, `run/`, `out/`, `demo/`). Delete it to
reset. Start/stop scripts only manage processes launched from this project.
