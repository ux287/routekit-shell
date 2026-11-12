import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// backlog.feat.rag-substrate-extract-package — RAG now lives in the standalone @routekit/rag package
// at packages/rag/src. Host consumers import via the bare specifier `@routekit/rag` (barrel) or a
// DECLARED subpath `@routekit/rag/<module>`; a RELATIVE deep path into the moved code is forbidden.
// This suite pins that boundary, the package's cycle-freedom (no static import back into the host),
// and barrel export identity.

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../..");
const HOST_SRC = resolve(ROOT, "packages/mcp-rks/src");
const RAG_SRC = resolve(ROOT, "packages/rag/src");

function walkMjs(dir, acc = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walkMjs(p, acc);
    else if (e.name.endsWith(".mjs")) acc.push(p);
  }
  return acc;
}

// Static import / export-from specifier extractor (dynamic import() and plain strings are ignored —
// they don't create a static module-graph edge, so they can't form a package cycle).
const fromRe = /^\s*(?:import|export)\b[^;]*?\bfrom\s*["']([^"']+)["']/gm;
function specifiers(src) {
  const out = [];
  let m;
  fromRe.lastIndex = 0;
  while ((m = fromRe.exec(src)) !== null) out.push(m[1]);
  return out;
}

describe("@routekit/rag extraction — package boundary", () => {
  it("no host file RELATIVE-deep-imports the moved RAG code (consumers must use @routekit/rag)", () => {
    const offenders = [];
    for (const file of walkMjs(HOST_SRC)) {
      for (const spec of specifiers(readFileSync(file, "utf8"))) {
        if (!spec.startsWith(".")) continue; // bare `@routekit/rag[/sub]`, npm, node: — fine
        const resolved = resolve(dirname(file), spec);
        if (resolved === RAG_SRC || resolved.startsWith(RAG_SRC + "/")) {
          offenders.push(`${file.slice(HOST_SRC.length + 1)} → ${spec}`);
        }
      }
    }
    expect(offenders, "host files must import RAG via @routekit/rag, not a relative deep path").toEqual([]);
  });

  it("CYCLE-FREEDOM: no file under packages/rag/src statically imports outside the package", () => {
    // A static import escaping the package — especially back into mcp-rks — would form a cross-package
    // cycle (Stage 1 host-hook DI removed the only two such edges). Bare specifiers (@routekit/cli,
    // npm deps, node: builtins) are allowed.
    const offenders = [];
    for (const file of walkMjs(RAG_SRC)) {
      for (const spec of specifiers(readFileSync(file, "utf8"))) {
        if (!spec.startsWith(".")) continue;
        const resolved = resolve(dirname(file), spec);
        if (resolved !== RAG_SRC && !resolved.startsWith(RAG_SRC + "/")) {
          offenders.push(`${file.slice(RAG_SRC.length + 1)} → ${spec}`);
        }
      }
    }
    expect(offenders, "packages/rag/src must not statically import outside itself").toEqual([]);
  });

  it("the RAG package never references the mcp-rks host (belt-and-suspenders)", () => {
    const offenders = [];
    for (const file of walkMjs(RAG_SRC)) {
      for (const spec of specifiers(readFileSync(file, "utf8"))) {
        if (spec.includes("mcp-rks")) offenders.push(`${file.slice(RAG_SRC.length + 1)} → ${spec}`);
      }
    }
    expect(offenders, "@routekit/rag must not import the mcp-rks host").toEqual([]);
  });

  it("the barrel resolves via @routekit/rag and re-exports the promoted symbols", async () => {
    const barrel = await import("@routekit/rag");
    expect(barrel.runRagQuery).toBeTypeOf("function");
    for (const sym of ["setRagHostHooks", "createCapabilityToken", "AGENT_ROLES", "expandQuery", "rerankResults", "inferQueryIntent"]) {
      expect(barrel[sym], `barrel must export ${sym}`).toBeDefined();
    }
  });

  it("a declared subpath resolves (@routekit/rag/fidelity-filter) — internals reachable without a relative path", async () => {
    const sub = await import("@routekit/rag/fidelity-filter");
    expect(sub.FIDELITY_LEVELS).toBeDefined();
  });

  it("behavior-preservation: barrel symbols are identical references to their source module", async () => {
    const barrel = await import("@routekit/rag");
    const tools = await import("@routekit/rag/tools");
    expect(barrel.runRagQuery).toBe(tools.runRagQuery);
    expect(barrel.runRagEmbed).toBe(tools.runRagEmbed);
  });
});
