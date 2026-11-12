#!/usr/bin/env node
// backlog.fix.remote-http-entry-env-leaks — TEST-ONLY harness, never shipped or published.
// Runs the remote entry's exported main() in THIS process (the bin runs main() itself only when it is
// argv[1], so importing it is inert), then answers presence probes on stdin, so a test can observe the
// running entry's process.env without adding a production debug surface to the bin.
// Request (one JSON line on stdin):  {"id":"<id>","keys":["NAME", ...],"patterns":["<regex source>", ...]}
// Reply (one line on stdout):        ENV_PROBE {"id":"<id>","present":{"NAME":bool},"patternPresent":{"<src>":bool}}
// Replies carry booleans only, never a value.
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const BIN = path.join(ROOT, "packages/mcp-rks/bin/mcp-rks-http.mjs");

const { main } = await import(pathToFileURL(BIN).href);
await main();

const has = (k) => Object.prototype.hasOwnProperty.call(process.env, k);
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let req;
  try { req = JSON.parse(line); } catch { return; }
  const present = {};
  for (const k of Array.isArray(req?.keys) ? req.keys : []) present[String(k)] = has(String(k));
  const patternPresent = {};
  for (const p of Array.isArray(req?.patterns) ? req.patterns : []) {
    let re = null;
    try { re = new RegExp(String(p)); } catch { re = null; }
    patternPresent[String(p)] = re ? Object.keys(process.env).some((k) => re.test(k)) : false;
  }
  process.stdout.write(`ENV_PROBE ${JSON.stringify({ id: String(req?.id ?? ""), present, patternPresent })}\n`);
});
