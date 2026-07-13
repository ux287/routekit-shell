import fs from "node:fs";
import path from "node:path";

export function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

export function makeTempDir(prefix = "tmp") {
  const base = path.join(process.cwd(), "tests", ".tmp");
  ensureDir(base);
  const stamp = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const dir = path.join(base, `${prefix}_${stamp}`);
  ensureDir(dir);
  return dir;
}

export function writeFile(filePath, content) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, content, "utf8");
}

