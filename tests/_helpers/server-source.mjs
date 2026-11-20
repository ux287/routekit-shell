/**
 * Location-independent access to the MCP tool-surface source.
 *
 * S1 of research.2026.10.05.server-mjs-safe-decomposition. Tests that pin
 * server.mjs source text resolve it ONLY through this module, so move-only
 * stories (S2-S10) that relocate dispatch branches into
 * packages/mcp-rks/src/server/handlers/ do not break or vacate those tests.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SERVER_REL = "packages/mcp-rks/src/server.mjs";
const HANDLERS_REL = "packages/mcp-rks/src/server/handlers";
const ANY_HEAD = "if (tool === ";
// S2: a registry registration `registerHandler(<"name" | 'name' | IDENT>, ...)` in
// packages/mcp-rks/src/server/handlers/ is also a dispatch head (start and terminator).
const REG_HEAD = "registerHandler(";
// A dispatch head is `if (tool === <"name" | 'name' | IDENT>)` and nothing else in the
// condition. A compound in-branch test such as `if (tool === 'x' && ...)` is NOT a head and
// must not end a slice (live instance: inside the rks_agent_run branch of server.mjs).
// The registration form must not be preceded by an identifier character, so a longer name
// such as `myregisterHandler(` is not a head.
const NEXT_HEAD_RE =
  /if \(tool === (?:"[^"\n]+"|'[^'\n]+'|[A-Za-z_$][\w$]*)\)|(?<![\w$])registerHandler\((?:"[^"\n]+"|'[^'\n]+'|[A-Za-z_$][\w$]*),/g;
const IDENT_CHAR_RE = /[\w$]/;

function listMjs(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listMjs(p));
    else if (entry.isFile() && entry.name.endsWith(".mjs")) out.push(p);
  }
  return out.sort();
}

export function serverSurfaceFiles({ root = DEFAULT_ROOT } = {}) {
  return [path.join(root, SERVER_REL), ...listMjs(path.join(root, HANDLERS_REL))];
}

export function readServerSurfaceSource({ root = DEFAULT_ROOT } = {}) {
  return serverSurfaceFiles({ root })
    .map((f) => fs.readFileSync(f, "utf8"))
    .join("\n");
}

export function readToolHandlerSource(tool, { root = DEFAULT_ROOT, identifier } = {}) {
  const heads = identifier
    ? [`${ANY_HEAD}${identifier})`, `${REG_HEAD}${identifier},`]
    : [
        `${ANY_HEAD}"${tool}")`,
        `${ANY_HEAD}'${tool}')`,
        `${REG_HEAD}"${tool}",`,
        `${REG_HEAD}'${tool}',`,
      ];
  const hits = [];
  for (const file of serverSurfaceFiles({ root })) {
    const src = fs.readFileSync(file, "utf8");
    for (const head of heads) {
      const guarded = head.startsWith(REG_HEAD);
      let at = src.indexOf(head);
      while (at !== -1) {
        if (!guarded || at === 0 || !IDENT_CHAR_RE.test(src[at - 1])) hits.push({ src, at });
        at = src.indexOf(head, at + 1);
      }
    }
  }
  const label = identifier ?? tool;
  if (hits.length === 0) throw new Error(`readToolHandlerSource: no dispatch head for ${label}`);
  if (hits.length > 1) throw new Error(`readToolHandlerSource: ${hits.length} dispatch heads for ${label}`);
  const { src, at } = hits[0];
  NEXT_HEAD_RE.lastIndex = at + 1;
  const next = NEXT_HEAD_RE.exec(src);
  return next === null ? src.slice(at) : src.slice(at, next.index);
}
