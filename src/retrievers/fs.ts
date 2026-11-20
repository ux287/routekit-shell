import { execa } from "execa";
import fs from "fs";
import path from "path";

export async function fsSearch(query: string, opts: { k: number; t: number }) {
  // Only search directories that exist
  const searchDirs = ["notes", "src"].filter(dir => {
    return fs.existsSync(path.resolve(dir));
  });
  
  if (searchDirs.length === 0) return [];
  
  const args = ["-n", "-H", "-C", "2", "--no-ignore", "--hidden", query, ...searchDirs];
  const { stdout } = await execa("rg", args, { timeout: opts.t }).catch((err) => {
    console.error("ripgrep error:", err.message);
    return { stdout: "" };
  });
  const lines = stdout.split("\n").filter(Boolean);

  const results = lines.slice(0, 1000).map(l => {
    // rg default: path:line:col:text  (sometimes :col is absent; best-effort parse)
    const [path, line, maybeCol, ...rest] = l.split(":");
    const maybeNum = Number(maybeCol);
    const hasCol = Number.isInteger(maybeNum);
    const text = hasCol ? rest.join(":") : [maybeCol, ...rest].join(":");
    const lineNum = Number(line) || 0;
    // naive scoring: more context → higher; cap at 1
    const score = Math.min(1, 0.5 + Math.min(0.5, text.length / 400));
    return { source: "fs" as const, path, line_start: lineNum, line_end: lineNum, text, score };
  });

  return results.slice(0, opts.k);
}