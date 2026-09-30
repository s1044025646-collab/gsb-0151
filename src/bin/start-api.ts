import { join } from 'node:path';
import { openDatabase } from '../db/database';
import { defaultClock } from '../db/database';
import { Repository } from '../db/repository';
import { CodecService } from '../service/service';
import { createApiServer, listenLocal } from '../api/server';

const root = process.cwd();
const dataDir = join(root, '.gbc', 'data');
const runDir = join(root, '.gbc', 'run');

const db = openDatabase(join(dataDir, 'gbc.sqlite'));
const service = new CodecService(new Repository(db, defaultClock));
const server = createApiServer(service);

listenLocal(server, runDir).then(({ port, pidFile }) => {
  console.log('[start-api] GBC1 API listening only on http://127.0.0.1:' + port);
  console.log('[start-api] pid file: ' + pidFile);
  console.log('[start-api] database: ' + join(dataDir, 'gbc.sqlite'));
});

function shutdown(): void {
  server.close(() => {
    db.close();
    process.exit(0);
  });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
