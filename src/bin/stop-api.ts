import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

// Only manages the pid file and process created by THIS project.
const pidFile = join(process.cwd(), '.gbc', 'run', 'api.pid');
if (!existsSync(pidFile)) {
  console.log('[stop-api] no pid file, nothing to stop');
  process.exit(0);
}
const info = JSON.parse(readFileSync(pidFile, 'utf8')) as { pid: number; port: number };
try {
  process.kill(info.pid, 'SIGTERM');
  console.log(`[stop-api] stopped project API pid=${info.pid} port=${info.port}`);
} catch (err) {
  console.log(`[stop-api] process ${info.pid} not running (${(err as Error).message}); removing pid file`);
}
rmSync(pidFile, { force: true });
