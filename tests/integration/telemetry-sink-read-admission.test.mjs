/**
 * telemetry-sink-read-admission.test.mjs
 *
 * Story: backlog.fix.telemetry-read-boundary-auditability (R7)
 *
 * Proves the two hook telemetry sinks are admitted to read-policy runtime_paths
 * NARROWLY — and that the admission did not open the telemetry directories.
 *
 * Both read gates are exercised against the REAL .routekit/read-policy.yaml:
 *   Gate A — packages/hooks/read/redirect-read-to-agent.mjs, spawned as a subprocess.
 *            Line scanner (loadRuntimePaths), compiles `*` to `[^/]*` (segment-confined).
 *            NEVER exits 2 — it denies by writing permissionDecision:"deny" to stdout.
 *   Gate B — classifyReadIntent from packages/hooks/lib/read-classification.mjs,
 *            in-process. js-yaml parsed, compiles `*` to `.*` (separator-BLIND).
 *
 * The gates DIVERGE by construction and this file pins that divergence rather than
 * asserting it away. See backlog.fix.runtime-path-glob-divergence.
 *
 * ISOLATION. The hook is spawned against a TEMP project root holding a verbatim byte
 * copy of the real policy — not against the repo root. redirect-read-to-agent.mjs
 * checks .rks/active-scope.json at step 0, BEFORE runtime paths, so running against
 * the live repo during an off-rail session would have off-rail scope decide every
 * assertion instead of the policy. The policy CONTENT under test is real; only the
 * ambient session state is neutralised.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import yaml from "../../packages/hooks/lib/js-yaml.mjs";
import { classifyReadIntent } from "../../packages/hooks/lib/read-classification.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

// Hook path is pinned EXPLICITLY to the source tree. resolveHookByName from
// tests/helpers/hook-path.mjs must NOT be used here: its first-hit order
// (.routekit/hooks -> .routekit/hooks.bak -> packages/hooks) can silently spawn a
// stale deployed copy, and .routekit/hooks is moved aside during off-rail sessions.
const HOOK_SRC = path.join(REPO_ROOT, "packages", "hooks", "read", "redirect-read-to-agent.mjs");

const REAL_POLICY = path.join(REPO_ROOT, ".routekit", "read-policy.yaml");

const LOG_SINK = ".routekit/telemetry/provenance-blocks.log";
const EVENTS_SINK = ".rks/telemetry/events-2026-08-13.jsonl";

let policySrc;
let policy;
let tmpRoot;

beforeAll(() => {
  // Precondition, deliberately BEFORE any admission assertion. If the hook is missing
  // or moved, every "gate A allows" assertion below would otherwise report green from a
  // hook that never ran — the exact false-green this file was repaired to prevent.
  if (!fs.existsSync(HOOK_SRC)) {
    throw new Error(`gate A hook not found at ${HOOK_SRC} — cannot evaluate admission`);
  }

  policySrc = fs.readFileSync(REAL_POLICY, "utf8");
  policy = yaml.load(policySrc).provenance_enforcement;

  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rks-telemetry-admission-"));
  fs.mkdirSync(path.join(tmpRoot, ".routekit"), { recursive: true });
  // Verbatim byte copy of the REAL policy — not a synthetic inline literal.
  fs.writeFileSync(path.join(tmpRoot, ".routekit", "read-policy.yaml"), policySrc, "utf8");
});

afterAll(() => {
  if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
});

/**
 * Gate A. Spawn the real hook against the temp project root.
 * Fresh session_id per call and RKS_GUARDRAILS=on, so an allow can only come from
 * the runtime_paths check — never from guardrails-off, off-rail scope, provenance
 * or the outage fallthrough.
 */
function gateA(relPath, hookPath = HOOK_SRC) {
  const input = JSON.stringify({
    session_id: randomUUID(),
    tool_name: "Read",
    tool_input: { file_path: path.join(tmpRoot, relPath) },
    cwd: tmpRoot,
  });
  let stdout;
  try {
    stdout = execFileSync("node", [hookPath], {
      input,
      env: {
        ...process.env,
        CLAUDE_PROJECT_DIR: tmpRoot,
        ROUTEKIT_PROJECT_ROOT: tmpRoot,
        RKS_GUARDRAILS: "on",
      },
      encoding: "utf8",
      timeout: 10_000,
    });
  } catch (e) {
    // Rethrow EVERYTHING, and do not inspect the error's shape.
    //
    // redirect-read-to-agent.mjs has no legitimate non-zero exit: every terminal path
    // is process.exit(0), including its top-level main().catch, and a deny is signalled
    // by writing JSON to stdout while still exiting 0. So a numeric non-zero status is
    // by construction a crash (syntax error, failed import, unresolvable entry module),
    // exactly as much a "the hook did not run" case as a spawn errno or a timeout kill.
    //
    // Because none of them is tolerated, none of them needs to be told apart. Swallowing
    // any of them into stdout="" would score a hook that never ran as an ALLOW.
    throw new Error(
      `gate A hook did not run to completion: ${hookPath} (target ${relPath})`,
      { cause: e },
    );
  }
  // Reached only on a clean exit 0. Assertions read stdout, never the exit code.
  // An ALLOW is legitimately SILENT: empty stdout IS the allow signal for this hook.
  return { stdout, denied: stdout.includes('"permissionDecision":"deny"') };
}

/** Gate B. In-process classifier, fed the REAL parsed policy sub-object. */
function gateB(relPath) {
  const prevClaude = process.env.CLAUDE_PROJECT_DIR;
  const prevRoutekit = process.env.ROUTEKIT_PROJECT_ROOT;
  process.env.CLAUDE_PROJECT_DIR = tmpRoot;
  process.env.ROUTEKIT_PROJECT_ROOT = tmpRoot;
  try {
    return classifyReadIntent({
      targetPath: relPath,
      toolName: "Read",
      toolInput: { file_path: relPath },
      config: policy,
      sessionId: randomUUID(),
    });
  } finally {
    if (prevClaude === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = prevClaude;
    if (prevRoutekit === undefined) delete process.env.ROUTEKIT_PROJECT_ROOT;
    else process.env.ROUTEKIT_PROJECT_ROOT = prevRoutekit;
  }
}

describe("telemetry sink read admission", () => {
  /**
   * MUTATION WITNESS. Points the runner at a hook that does not exist and proves the
   * failure is loud. Before this repair the helper swallowed the error into stdout="",
   * returned denied:false, and every admission assertion passed against a hook that
   * never executed.
   *
   * Note the mechanism: a missing hook FILE is NOT a spawn ENOENT. The node binary
   * resolves and spawnSync succeeds; node then exits non-zero on module resolution.
   * Only a missing NODE BINARY is a genuine spawn ENOENT. Under rethrow-everything
   * both throw, which is why this witness is satisfiable at all.
   */
  describe("MUTATION WITNESS — a hook that never ran is never an allow", () => {
    const MISSING_HOOK = path.join(REPO_ROOT, "packages", "hooks", "read", "__no-such-hook__.mjs");

    it("throws, and does not report an allow", () => {
      expect(fs.existsSync(MISSING_HOOK)).toBe(false);
      // Asserts on the message gateA itself constructs, never on Node's
      // ERR_MODULE_NOT_FOUND text, which varies by Node version.
      expect(() => gateA(LOG_SINK, MISSING_HOOK)).toThrow(
        /gate A hook did not run to completion/,
      );
    });

    it("returns no result at all for a hook that never ran", () => {
      let returned;
      try {
        returned = gateA(LOG_SINK, MISSING_HOOK);
      } catch {
        /* expected — asserted above */
      }
      // The specific regression: this was previously { stdout: "", denied: false }.
      expect(returned).toBeUndefined();
    });

    it("still evaluates the real hook normally", () => {
      // Guards against a repair that throws unconditionally and passes the two
      // assertions above for the wrong reason.
      expect(gateA(LOG_SINK).denied).toBe(false);
    });
  });

  describe("the two named sinks are admitted", () => {
    it("gate B allows the provenance-blocks log with reason runtime_config", () => {
      const r = gateB(LOG_SINK);
      expect(r.allowed).toBe(true);
      expect(r.reason).toBe("runtime_config");
      expect(r.metadata.matchedRule).toBe("runtime_paths");
    });

    it("gate B allows a dated events sink with reason runtime_config", () => {
      const r = gateB(EVENTS_SINK);
      expect(r.allowed).toBe(true);
      expect(r.reason).toBe("runtime_config");
      expect(r.metadata.matchedRule).toBe("runtime_paths");
    });

    it("gate A allows both sinks silently", () => {
      expect(gateA(LOG_SINK).denied).toBe(false);
      expect(gateA(EVENTS_SINK).denied).toBe(false);
    });
  });

  // These are the load-bearing tests. The story admits two sinks, not two directories.
  describe("NARROWNESS — the admission is sink-specific, not directory-wide", () => {
    const denyBoth = [
      [".routekit/telemetry/other-sink.log", "unnamed sink beside the log"],
      [".rks/telemetry/credentials.jsonl", "non-events file in the events directory"],
      [".routekit/telemetry/provenance-blocks.log.bak", "suffixed variant — proves literal, not prefix"],
      [".routekit/telemetry/nested/provenance-blocks.log", "nested — proves literal, not subtree"],
    ];

    for (const [relPath, why] of denyBoth) {
      it(`denies ${relPath} at BOTH gates (${why})`, () => {
        expect(gateB(relPath).allowed).toBe(false);
        expect(gateA(relPath).denied).toBe(true);
      });
    }

    it("declares no blanket telemetry glob", () => {
      const entries = policy.runtime_paths;
      expect(entries).not.toContain(".rks/telemetry/*");
      expect(entries).not.toContain(".routekit/telemetry/*");
      for (const e of entries) {
        expect(e.endsWith("telemetry/*")).toBe(false);
      }
    });
  });

  /**
   * The gates compile wildcards differently and CANNOT be made to agree by pattern
   * authoring: gate A uses [^/]* (segment-confined), gate B uses .* (separator-blind).
   * A nested path inserts a '/' into the wildcard span, so gate B over-matches.
   *
   * This is safe today because gate A's permissionDecision:"deny" is authoritative —
   * any PreToolUse deny blocks the call, so the net outcome is denial. The divergence
   * is pinned here so a change to either compiler fails loudly.
   * Tracked for reconciliation in backlog.fix.runtime-path-glob-divergence.
   */
  describe("GLOB-DIVERGENCE WITNESS", () => {
    const nested = ".rks/telemetry/events-x/leaked.jsonl";

    it("gate A DENIES the nested over-match ([^/]* stops at the separator)", () => {
      expect(gateA(nested).denied).toBe(true);
    });

    it("gate B ALLOWS the nested over-match (.* crosses the separator) — known divergence", () => {
      // Deliberately pinned as ALLOWED. This is not the desired end state; it records
      // real current behaviour so backlog.fix.runtime-path-glob-divergence can flip it
      // intentionally rather than silently. Do NOT "fix" this by asserting agreement.
      expect(gateB(nested).allowed).toBe(true);
    });
  });

  /**
   * The rationale comment sits INSIDE the runtime_paths list. Gate A's loadRuntimePaths
   * is a line scanner that terminates on the first non-blank, non-#, non-"- " line, so a
   * malformed comment would silently truncate gate A's list while gate B (js-yaml) still
   * saw it. Entries positioned AFTER the comment prove no truncation occurred.
   */
  describe("PARSER-TRUNCATION GUARD", () => {
    it("gate A still honours entries positioned after the inserted comment", () => {
      expect(gateA("notes/backlog.some-story.md").denied).toBe(false);
      expect(gateA("notes/research.some-paper.md").denied).toBe(false);
      expect(gateA("notes/how-to.something.md").denied).toBe(false);
    });

    it("gate A's line scan reaches every entry js-yaml sees", () => {
      // Replicates loadRuntimePaths exactly: find the header by exact equality, then
      // collect "- " lines, skipping blanks and #-comments, terminating on the first
      // other non-blank line. If any rationale line were not #-prefixed, the scan would
      // stop early and this count would fall short of the js-yaml count.
      const lines = policySrc.split("\n");
      const start = lines.findIndex((l) => l.trim() === "runtime_paths:");
      expect(start).toBeGreaterThan(-1);

      const scanned = [];
      for (let i = start + 1; i < lines.length; i++) {
        const t = lines[i].trim();
        if (t === "") continue;
        if (t.startsWith("#")) continue;
        if (t.startsWith("- ")) {
          scanned.push(t.slice(2).replace(/^["']|["']$/g, ""));
          continue;
        }
        break; // terminator — end of the runtime_paths block
      }

      expect(scanned).toEqual(policy.runtime_paths);
      expect(scanned).toContain(LOG_SINK);
      expect(scanned).toContain(".rks/telemetry/events-*.jsonl");
    });
  });

  /**
   * If the header check (trimmed === "runtime_paths:") ever fails, loadRuntimePaths
   * silently falls back to hardcoded defaults that omit these entries — a catastrophic
   * silent regression that would otherwise leave the suite green. Behavioural proof:
   * these paths are allowed ONLY if the real list was loaded.
   */
  describe("HEADER-INTEGRITY GUARD", () => {
    it("the real parsed list is non-empty and retains its pre-existing entries", () => {
      expect(policy.runtime_paths.length).toBeGreaterThan(0);
      for (const e of [".rks/prompts/*", "README.md", "AGENTS.md", "notes/backlog.*"]) {
        expect(policy.runtime_paths).toContain(e);
      }
    });

    it("gate A allows entries absent from its hardcoded fallback defaults", () => {
      expect(gateA("README.md").denied).toBe(false);
      expect(gateA("AGENTS.md").denied).toBe(false);
      expect(gateA(".rks/prompts/governor-po.md").denied).toBe(false);
    });
  });

  describe("security rationale is recorded in the policy file", () => {
    it("states the credential-material reason and the do-not-widen rule", () => {
      expect(policySrc).toMatch(/credential/i);
      expect(policySrc).toMatch(/telemetry/i);
      expect(policySrc).toMatch(/do not widen|not be widened|directory glob/i);
    });
  });

  describe("hook resolution and deploy parity", () => {
    it("pins the hook to the source tree, not a deployed copy", () => {
      expect(HOOK_SRC).toContain(path.join("packages", "hooks", "read"));
      expect(fs.existsSync(HOOK_SRC)).toBe(true);
    });

    /**
     * Pinning the source copy opens the inverse gap: .claude/settings.json actually
     * EXECUTES .routekit/hooks/read/. Without this, a stale deployed copy leaves the
     * suite green while the live gate is broken. existsSync-guarded because
     * .routekit/hooks is moved aside during an active off-rail session.
     */
    it("source, deployed and template copies are byte-identical where present", () => {
      const src = fs.readFileSync(HOOK_SRC);
      const copies = [
        path.join(REPO_ROOT, ".routekit", "hooks", "read", "redirect-read-to-agent.mjs"),
        path.join(REPO_ROOT, "templates", "generic", ".routekit", "hooks", "read", "redirect-read-to-agent.mjs"),
      ];
      for (const c of copies) {
        if (!fs.existsSync(c)) continue;
        expect(fs.readFileSync(c).equals(src), `${path.relative(REPO_ROOT, c)} drifted from source`).toBe(true);
      }
    });
  });
});
