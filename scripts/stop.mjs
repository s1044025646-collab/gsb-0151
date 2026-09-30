// Stop only the server whose PID this project itself recorded in ./tmp/gbc.pid.
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const pidFile = join(process.cwd(), "tmp", "gbc.pid");
if (!existsSync(pidFile)) {
  console.log("no pid file; server is not running (or was started elsewhere)");
  process.exit(0);
}
const [pid] = readFileSync(pidFile, "utf8").trim().split(/\s+/);
try {
  process.kill(Number(pid));
  console.log(`stopped GBC server pid ${pid}`);
} catch (err) {
  console.log(`pid ${pid} was not running`);
} finally {
  rmSync(pidFile, { force: true });
}
