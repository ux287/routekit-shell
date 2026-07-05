#!/usr/bin/env node
import { fileURLToPath } from "url";
import fs from "fs";
import path from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..",);
const notesDir = path.join(rootDir, "notes");
const outFile = path.join(rootDir, "src/data/portfolio.json");

function collectEntries() {
  if (!fs.existsSync(notesDir)) return [];
  return fs
    .readdirSync(notesDir)
    .filter((file) => file.startsWith("stack.portfolio") && file.endsWith(".md"))
    .map((file) => ({ slug: file.replace(/\.md$/, ""), title: file }));
}

const entries = collectEntries();
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, JSON.stringify(entries, null, 2));
console.log(`Wrote ${entries.length} portfolio entries to ${path.relative(process.cwd(), outFile)}`);
