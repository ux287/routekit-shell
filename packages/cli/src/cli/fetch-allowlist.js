/**
 * routekit fetch-allowlist — human-run editor for THIS project's
 * .rks/project.json → fetchRaw.allowedHosts (backlog.feat.fetch-allowlist-owner-cli).
 *
 *   routekit fetch-allowlist list            [--path=<projectRoot>]
 *   routekit fetch-allowlist add <host>      [--path=<projectRoot>]
 *   routekit fetch-allowlist remove <host>   [--path=<projectRoot>]
 *
 * The space form `--path <projectRoot>` is also accepted, before or after the host:
 * the host is the first positional token after the subcommand.
 *
 * add/remove require an interactive terminal and an operator confirmation (ARCH gate G1):
 * there is no MCP surface, so no Governor can reach this through the rks server.
 * Never touches fetchRaw.mode or any key other than fetchRaw.allowedHosts.
 *
 * Writes re-read project.json after confirmation (so a concurrent edit is kept) and go
 * through a same-directory temp file plus rename.
 *
 * Results are evidence-bound: `changed` and `allowedHosts` come from re-reading
 * .rks/project.json after the write; `audited` is the observed outcome of the emit.
 */
import fs from "fs";
import path from "path";
import readline from "readline";
import { hostAllowed } from "../../../mcp-rks/src/agents/fetch-raw.mjs";
import { createDefaultTelemetryEmitter } from "./dispatch.js";

export const AUDIT_EVENT_TYPE = "cli.fetch-allowlist.changed";

const HOST_PATTERN = /^(\*\.|\.)?[a-z0-9-]+(\.[a-z0-9-]+)+$/i;

const EMPTY_HOST_ERROR = "empty host: pass a hostname such as docs.example.com";

const USAGE = "usage: routekit fetch-allowlist list|add <host>|remove <host> [--path=<projectRoot>]";

export const NOT_A_TERMINAL_MESSAGE =
  "routekit fetch-allowlist add/remove must be run by a person in an interactive terminal " +
  "(stdin and stdout must be a TTY); no change was made.";

/** Validate an entry against the grammar hostAllowed honours. Returns { ok, host } or { ok:false, error }. */
export function validateHostEntry(raw) {
  const value = String(raw ?? "").trim();
  if (!value) return { ok: false, error: EMPTY_HOST_ERROR };
  if (value.includes("://")) {
    try {
      const hostname = new URL(value).hostname;
      if (hostname) return { ok: false, error: `pass a hostname, not a URL: try '${hostname}'` };
    } catch {
      /* fall through */
    }
    return { ok: false, error: "pass a hostname, not a URL" };
  }
  if (!HOST_PATTERN.test(value)) {
    return {
      ok: false,
      error: `not a valid host pattern: '${value}' (use a bare host, *.base or .base; no scheme, path, port or whitespace)`,
    };
  }
  const probe = value.replace(/^\*\./, "").replace(/^\./, "");
  if (!hostAllowed(probe, [value])) return { ok: false, error: `pattern not honoured by hostAllowed: '${value}'` };
  return { ok: true, host: value.toLowerCase() };
}

/**
 * Lenient check for remove: any non-empty value with no whitespace, so a hand-written
 * legacy entry (e.g. a single-label 'localhost') can still be cleared.
 */
function validateRemoveEntry(raw) {
  const value = String(raw ?? "");
  if (!value.trim()) return { ok: false, error: EMPTY_HOST_ERROR };
  if (/\s/.test(value)) return { ok: false, error: `not a valid entry to remove: '${value}' (no whitespace)` };
  return { ok: true, host: value.toLowerCase() };
}

/**
 * The first positional token after the subcommand (args[0] is the command, args[1] the
 * subcommand). Skips every --flag token and the value a space-form flag consumes, using
 * the same rule as parseArgs in routekit.js: a --key token with no =value consumes the
 * next token when it exists and does not start with "--".
 */
function positionalHost(args) {
  let idx = 2;
  while (idx < args.length) {
    const token = String(args[idx]);
    if (!token.startsWith("--")) return token;
    const value = token.replace(/^--/, "").split("=")[1];
    if (value === undefined || value === "") {
      const next = args[idx + 1];
      if (next && !String(next).startsWith("--")) {
        idx += 2;
        continue;
      }
    }
    idx += 1;
  }
  return undefined;
}

/** Read project.json. Returns { ok, cfg, raw } or { ok:false, error }. */
function readProjectJson(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (e) {
    return { ok: false, error: `cannot read ${file}: ${e.code || e.message}` };
  }
  try {
    const cfg = JSON.parse(raw);
    if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) return { ok: false, error: `${file} is not a JSON object` };
    return { ok: true, cfg, raw };
  } catch (e) {
    return { ok: false, error: `${file} is not valid JSON: ${e.message}` };
  }
}

/** Write content to a temp file in the same directory, then rename it over file. Removes the temp on failure. */
function writeAtomic(file, content) {
  const tmp = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`,
  );
  try {
    fs.writeFileSync(tmp, content);
    fs.renameSync(tmp, file);
  } catch (e) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* best effort */
    }
    throw e;
  }
}

function hostsOf(cfg) {
  const list = cfg?.fetchRaw?.allowedHosts;
  return Array.isArray(list) ? list.slice() : [];
}

function sameList(a, b) {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** Default confirmation: a readline yes/no prompt on stdin/stdout. Only "y"/"yes" confirms. */
function defaultConfirm(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`${question} [y/N] `, (answer) => {
      rl.close();
      resolve(/^\s*y(es)?\s*$/i.test(String(answer || "")));
    });
  });
}

/**
 * Entry point. args is process.argv.slice(2): the host is the first positional token
 * after the subcommand, skipping --flag tokens and space-form flag values (parseArgs
 * puts only --key flags into kv). deps injects isTTY, confirm, emit, stdout; when emit
 * is not injected the default telemetry emitter is built only once a change is applied.
 */
export async function handleFetchAllowlistCommand({ sub, kv = {}, args = [] }, deps = {}) {
  const projectRoot = path.resolve(typeof kv.path === "string" && kv.path ? kv.path : process.cwd());
  const file = path.join(projectRoot, ".rks", "project.json");
  const rawHost = positionalHost(args);
  const {
    isTTY = Boolean(process.stdin.isTTY && process.stdout.isTTY),
    stdout = process.stdout,
    confirm = defaultConfirm,
  } = deps;

  if (sub === "list") {
    const read = readProjectJson(file);
    if (!read.ok) return { ok: false, op: "list", error: read.error, file };
    return { ok: true, op: "list", allowedHosts: hostsOf(read.cfg), file };
  }

  if (sub !== "add" && sub !== "remove") {
    return {
      ok: false,
      error: `unknown subcommand: ${sub ?? "(none)"} — ${USAGE}`,
    };
  }
  const op = sub;

  const v = op === "add" ? validateHostEntry(rawHost) : validateRemoveEntry(rawHost);
  if (!v.ok) return { ok: false, op, error: v.error, file };
  const host = v.host;

  // ARCH gate G1: a person at an interactive terminal, nothing else.
  if (!isTTY) return { ok: false, op, host, reason: "not_a_terminal", error: NOT_A_TERMINAL_MESSAGE, file };

  const before = readProjectJson(file);
  if (!before.ok) return { ok: false, op, host, error: before.error, file };
  const initial = hostsOf(before.cfg);
  const isPresent = (list) => list.some((h) => String(h).toLowerCase() === host);

  // No-op: no write, no confirmation needed, no event.
  if ((op === "add" && isPresent(initial)) || (op === "remove" && !isPresent(initial))) {
    return { ok: true, op, host, changed: false, allowedHosts: initial, file };
  }

  const question =
    op === "add"
      ? `Add '${host}' to fetchRaw.allowedHosts in ${file}?`
      : `Remove '${host}' from fetchRaw.allowedHosts in ${file}?`;
  let confirmed = false;
  try {
    confirmed = (await confirm(question)) === true;
  } catch {
    confirmed = false;
  }
  if (!confirmed) return { ok: false, op, host, reason: "declined", error: "operator declined; no change was made", file };

  // Fresh read after confirmation: an edit made while the prompt was pending is kept.
  const fresh = readProjectJson(file);
  if (!fresh.ok) return { ok: false, op, host, error: fresh.error, file };
  const prior = hostsOf(fresh.cfg);
  if ((op === "add" && isPresent(prior)) || (op === "remove" && !isPresent(prior))) {
    return { ok: true, op, host, changed: false, allowedHosts: prior, file };
  }

  const next = op === "add" ? [...prior, host] : prior.filter((h) => String(h).toLowerCase() !== host);
  const cfg = fresh.cfg;
  const fetchRaw = cfg.fetchRaw && typeof cfg.fetchRaw === "object" && !Array.isArray(cfg.fetchRaw) ? cfg.fetchRaw : {};
  cfg.fetchRaw = { ...fetchRaw, allowedHosts: next };
  const trailingNewline = fresh.raw.endsWith("\n") ? "\n" : "";
  try {
    writeAtomic(file, JSON.stringify(cfg, null, 2) + trailingNewline);
  } catch (e) {
    return { ok: false, op, host, error: `cannot write ${file}: ${e.code || e.message}`, file };
  }

  // Evidence-bound result: re-read and compare.
  const after = readProjectJson(file);
  if (!after.ok) return { ok: false, op, host, error: `read-back failed: ${after.error}`, file };
  const allowedHosts = hostsOf(after.cfg);
  const changed = !sameList(prior, allowedHosts);
  const nowPresent = isPresent(allowedHosts);
  const applied = changed && (op === "add" ? nowPresent : !nowPresent);
  if (!applied) {
    return { ok: false, op, host, error: "read-back of .rks/project.json does not show the requested change", allowedHosts, file };
  }

  let audited = false;
  try {
    const emit = deps.emit ?? createDefaultTelemetryEmitter({ targetRoot: projectRoot });
    await emit(AUDIT_EVENT_TYPE, { op, host, projectRoot });
    audited = true;
  } catch {
    audited = false;
  }
  if (!audited) {
    stdout.write(
      `warning: fetch-allowlist ${op} '${host}' was applied to ${file}, but the ${AUDIT_EVENT_TYPE} audit event could not be recorded\n`,
    );
  }
  return { ok: true, op, host, changed: true, audited, allowedHosts, file };
}
