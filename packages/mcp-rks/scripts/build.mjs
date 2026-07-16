#!/usr/bin/env node

import { mkdirSync, copyFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const pkgRoot = dirname(__dirname);

const src = join(pkgRoot, "src", "server.mjs");
const distDir = join(pkgRoot, "dist");
const dest = join(distDir, "server.mjs");

mkdirSync(distDir, { recursive: true });
copyFileSync(src, dest);
console.log(`Copied ${src} -> ${dest}`);
