// Removes only this project's generated artifacts: ./dist and ./tmp.
import { rmSync } from "node:fs";
import { resolve } from "node:path";

for (const target of ["dist", "tmp"]) {
  const abs = resolve(process.cwd(), target);
  if (!abs.startsWith(resolve(process.cwd()))) continue;
  rmSync(abs, { recursive: true, force: true });
  console.log(`removed ${target}`);
}
