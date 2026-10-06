/**
 * Tests for backlog.fix.harness-session-output-read-allowance.
 *
 * An agent could not read its own overflowed tool output. When a tool result is
 * too large the harness persists it and returns only the path — and the read
 * gates then denied that path. Four occurrences in a single session: an 83KB CI
 * log, a 141KB research output, a blocked listing of the session's OWN
 * scratchpad, and a blocked /dev/null redirect target (the last is deliberately
 * out of scope — a device node, tracked separately).
 *
 * THE ALLOWANCE IS NARROW BY CONSTRUCTION and most of this file exists to prove
 * that. It is the same slot and spirit as the step-8.5 write ledger ("read a
 * file you just wrote"), keyed to session identity. The negative tests are the
 * point: without them this story would remove a guardrail rather than fix a bug.
 *
 * HOOK RESOLUTION: hooks are spawned from packages/hooks/ — the SOURCE — not via
 * a deploy-preferring lookup. .routekit/hooks/ is a build artifact, and during an
 * off-rail session it is moved aside entirely, so a deploy-first resolver would
 * silently spawn a stale copy and report a false result.
 */

import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  isHarnessSessionOutputPath,
  classifyReadIntent,
} from "../../packages/hooks/lib/read-classification.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "../..");
const HOOKS_SRC = path.join(PROJECT_ROOT, "packages", "hooks");

const SESSION = "03a1e7b1-94e8-486c-b113-9f4f7fb8a05a";
const OTHER_SESSION = "99999999-0000-0000-0000-000000000000";
const BASE = `/private/tmp/claude-501/-Users-someone-project/${SESSION}`;

function callHook(relHookPath, toolName, toolInput, sessionId, envOverrides = {}) {
  const hookPath = path.join(HOOKS_SRC, relHookPath);
  // session_id is part of the PreToolUse stdin envelope. The canonical helper in
  // tests/integration/enforce-targetfile-scope.test.mjs omits it — copied
  // verbatim against fail-closed semantics, every positive case here would block.
  const input = JSON.stringify({
    session_id: sessionId,
    tool_name: toolName,
    tool_input: toolInput,
  });
  return new Promise((resolve) => {
    const proc = spawn("node", [hookPath], {
      cwd: PROJECT_ROOT,
      env: { ...process.env, CLAUDE_PROJECT_DIR: PROJECT_ROOT, RKS_GUARDRAILS: "on", ...envOverrides },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { proc.kill(); } catch { /* already gone */ }
      resolve({ code: 124, stdout, stderr, blocked: false, timedOut: true });
    }, 10_000);
    proc.stdout.on("data", (d) => (stdout += d));
    proc.stderr.on("data", (d) => (stderr += d));
    proc.stdin.write(input);
    proc.stdin.end();
    proc.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr, blocked: code === 2 });
    });
  });
}

describe("read-classification.mjs — four-copy parity", () => {
  // This module is vendored four ways and had NO automated drift guard:
  // sync-hooks.mjs's checkOrphans excludes lib/ from its drift scan, and
  // posttooluse-payload-contract.test.mjs's parity check iterates tier hooks
  // only. A silent divergence here means the deployed hook and the source stop
  // agreeing — which is exactly the source-vs-deploy confusion that has misled
  // this repo before.
  const COPIES = [
    "packages/hooks/lib/read-classification.mjs",
    "packages/mcp-rks/src/shared/read-classification.mjs",
    ".routekit/hooks/lib/read-classification.mjs",
    "templates/generic/.routekit/hooks/lib/read-classification.mjs",
  ];

  it("all four copies are byte-identical", () => {
    const [first, ...rest] = COPIES.map((p) => fs.readFileSync(path.join(PROJECT_ROOT, p), "utf8"));
    for (let i = 0; i < rest.length; i++) {
      expect(rest[i] === first, `${COPIES[i + 1]} differs from ${COPIES[0]}`).toBe(true);
    }
  });

  it("every copy carries the recorded no-Bash-allowance decision", () => {
    // Gives the decision a witness so it cannot be silently deleted.
    for (const rel of COPIES) {
      const src = fs.readFileSync(path.join(PROJECT_ROOT, rel), "utf8");
      expect(src, `${rel} lost the decision record`).toContain("No Bash allowance");
    }
  });

  it("every copy admits images inside the HARNESS_SESSION_LEAVES definition", () => {
    // backlog.fix.harness-session-images-read-allowance: a screenshot the user
    // pastes into this session lands in <harness-root>/<session-id>/images/.
    for (const rel of COPIES) {
      const src = fs.readFileSync(path.join(PROJECT_ROOT, rel), "utf8");
      const def = src.match(/const HARNESS_SESSION_LEAVES = new Set\(\[([^\]]*)\]\)/);
      expect(def, `${rel} lost the HARNESS_SESSION_LEAVES definition`).not.toBeNull();
      expect(def[1], `${rel} does not admit images`).toContain("'images'");
    }
  });
});

describe("isHarnessSessionOutputPath — the allowance", () => {
  it("accepts all four harness output leaves for the current session", () => {
    for (const leaf of ["tasks", "scratchpad", "tool-results", "images"]) {
      expect(
        isHarnessSessionOutputPath(`${BASE}/${leaf}/whatever.txt`, SESSION),
        `expected allow for ${leaf}`,
      ).toBe(true);
    }
  });

  it("accepts a nested path beneath a leaf", () => {
    expect(isHarnessSessionOutputPath(`${BASE}/scratchpad/a/b/c.json`, SESSION)).toBe(true);
  });

  it("accepts an image the user pasted into this session", () => {
    expect(isHarnessSessionOutputPath(`${BASE}/images/2.png`, SESSION)).toBe(true);
  });

  it("accepts a nested path beneath images", () => {
    expect(isHarnessSessionOutputPath(`${BASE}/images/sub/3.png`, SESSION)).toBe(true);
  });
});

describe("isHarnessSessionOutputPath — images stays as narrow as the other leaves", () => {
  it("rejects ANOTHER session's images", () => {
    const foreign = `/private/tmp/claude-501/-Users-someone-project/${OTHER_SESSION}/images/2.png`;
    expect(isHarnessSessionOutputPath(foreign, SESSION)).toBe(false);
  });

  it("requires SEGMENT equality for images, not a substring match", () => {
    const sneaky = `/private/tmp/claude-501/-Users-someone-project/${SESSION}-evil/images/2.png`;
    expect(isHarnessSessionOutputPath(sneaky, SESSION)).toBe(false);
  });

  it("closes .. traversal out of the session's images directory", () => {
    expect(isHarnessSessionOutputPath(`${BASE}/images/../../other/x.png`, SESSION)).toBe(false);
  });

  it("fails closed for images when the session id is missing, empty or blank", () => {
    for (const bad of [undefined, null, "", "   "]) {
      expect(
        isHarnessSessionOutputPath(`${BASE}/images/2.png`, bad),
        `expected fail-closed for ${JSON.stringify(bad)}`,
      ).toBe(false);
    }
  });

  it("still rejects a sibling leaf that is not in the set", () => {
    expect(isHarnessSessionOutputPath(`${BASE}/private/x.png`, SESSION)).toBe(false);
  });
});

describe("isHarnessSessionOutputPath — the negatives that keep it narrow", () => {
  it("rejects ANOTHER session's output", () => {
    const foreign = `/private/tmp/claude-501/-Users-someone-project/${OTHER_SESSION}/tasks/x.output`;
    expect(isHarnessSessionOutputPath(foreign, SESSION)).toBe(false);
  });

  it("fails closed when the session id is missing, empty or blank", () => {
    for (const bad of [undefined, null, "", "   "]) {
      expect(
        isHarnessSessionOutputPath(`${BASE}/tasks/x.output`, bad),
        `expected fail-closed for ${JSON.stringify(bad)}`,
      ).toBe(false);
    }
  });

  it("requires SEGMENT equality, not a substring match", () => {
    // `<session-id>-evil` would satisfy a naive includes() check.
    const sneaky = `/private/tmp/claude-501/-Users-someone-project/${SESSION}-evil/tasks/x.output`;
    expect(isHarnessSessionOutputPath(sneaky, SESSION)).toBe(false);
  });

  it("closes .. traversal out of the session directory", () => {
    // Normalization happens BEFORE matching, so the escape collapses first.
    expect(isHarnessSessionOutputPath(`${BASE}/tasks/../../../../etc/passwd`, SESSION)).toBe(false);
    expect(isHarnessSessionOutputPath(`${BASE}/tasks/../../other/secrets.txt`, SESSION)).toBe(false);
  });

  it("rejects a sibling leaf that is not a harness output directory", () => {
    expect(isHarnessSessionOutputPath(`${BASE}/private/x.txt`, SESSION)).toBe(false);
    expect(isHarnessSessionOutputPath(`${BASE}/x.txt`, SESSION)).toBe(false);
  });

  it("rejects the session id appearing as a FILENAME rather than a directory", () => {
    // segments[idx + 1] is undefined here, and undefined is not in the leaf set,
    // so it fails closed. Implicit in the implementation — pinned so it stays true.
    expect(isHarnessSessionOutputPath(`/some/tasks/${SESSION}`, SESSION)).toBe(false);
    expect(isHarnessSessionOutputPath(`/var/log/${SESSION}`, SESSION)).toBe(false);
  });

  it("rejects project source and arbitrary absolute paths", () => {
    for (const p of [
      path.join(PROJECT_ROOT, "packages/mcp-rks/src/server.mjs"),
      "/etc/passwd",
      `${process.env.HOME || "/root"}/.ssh/id_rsa`,
    ]) {
      expect(isHarnessSessionOutputPath(p, SESSION), `expected reject for ${p}`).toBe(false);
    }
  });

  it("is not keyed to a hardcoded uid or tmp root", () => {
    // The rule must follow session identity, not a magic /private/tmp/claude-501
    // prefix — the harness also persists under ~/.claude/projects/<slug>/<id>/.
    const home = `/Users/someone/.claude/projects/-Users-someone-project/${SESSION}/tool-results/a.txt`;
    expect(isHarnessSessionOutputPath(home, SESSION)).toBe(true);
    const otherUid = `/private/tmp/claude-999/-Users-someone-project/${SESSION}/tasks/a.output`;
    expect(isHarnessSessionOutputPath(otherUid, SESSION)).toBe(true);
  });
});

describe("classifyReadIntent — rule placement", () => {
  const config = { mode: "block" };

  it("allows the session's own output instead of falling through to the default block", () => {
    const result = classifyReadIntent({
      targetPath: `${BASE}/tasks/x.output`,
      toolName: "Read",
      toolInput: {},
      config,
      sessionId: SESSION,
    });
    expect(result.allowed).toBe(true);
    expect(result.metadata.matchedRule).toBe("harnessSessionOutput");
  });

  it("still blocks a foreign session at the default rule", () => {
    const result = classifyReadIntent({
      targetPath: `/private/tmp/claude-501/p/${OTHER_SESSION}/tasks/x.output`,
      toolName: "Read",
      toolInput: {},
      config,
      sessionId: SESSION,
    });
    expect(result.allowed).toBe(false);
    expect(result.metadata.matchedRule).toBe("default:mode=block");
  });

  it("allows the session's own pasted image instead of the 'no provenance' block", () => {
    const result = classifyReadIntent({
      targetPath: `${BASE}/images/2.png`,
      toolName: "Read",
      toolInput: {},
      config,
      sessionId: SESSION,
    });
    expect(result.allowed).toBe(true);
    expect(result.metadata.matchedRule).toBe("harnessSessionOutput");
  });

  it("still blocks a foreign session's image at the default rule", () => {
    const result = classifyReadIntent({
      targetPath: `/private/tmp/claude-501/p/${OTHER_SESSION}/images/2.png`,
      toolName: "Read",
      toolInput: {},
      config,
      sessionId: SESSION,
    });
    expect(result.allowed).toBe(false);
    expect(result.metadata.matchedRule).toBe("default:mode=block");
  });

  it("carves Grep out at rule 7, which sits BEFORE the write ledger", () => {
    // Rule 7 blocks Glob/Grep before execution can reach 8.5/8.6, so a rule
    // added only after 8.5 would be unreachable for these two tools.
    const allowed = classifyReadIntent({
      targetPath: `${BASE}/tool-results/x.txt`,
      toolName: "Grep",
      toolInput: {},
      config,
      sessionId: SESSION,
    });
    expect(allowed.allowed).toBe(true);

    const blocked = classifyReadIntent({
      targetPath: path.join(PROJECT_ROOT, "packages"),
      toolName: "Grep",
      toolInput: {},
      config,
      sessionId: SESSION,
    });
    expect(blocked.allowed).toBe(false);
    expect(blocked.metadata.matchedRule).toBe("patternSearchTool");
  });
});

describe("both gates honour the allowance end to end", () => {
  // NOTE ON GATE COUNT. The story named redirect-read-to-agent.mjs as one of the
  // blocking gates. It is NOT one for these paths: that hook exits 0 at :133-135
  // for anything outside PROJECT_DIR, and every harness output path is outside
  // the project. The gates that actually govern this path class are
  // enforce-read-provenance (via classifyReadIntent) and redirect-grep-to-agent.
  // Adding a carve-out to redirect-read-to-agent would have been dead code.

  it("enforce-read-provenance lets the session read its own output", async () => {
    const res = await callHook(
      "read/enforce-read-provenance.mjs",
      "Read",
      { file_path: `${BASE}/tasks/x.output` },
      SESSION,
    );
    expect(res.timedOut).toBeFalsy();
    expect(res.blocked).toBe(false);
  });

  it("enforce-read-provenance still blocks ANOTHER session's output", async () => {
    const res = await callHook(
      "read/enforce-read-provenance.mjs",
      "Read",
      { file_path: `/private/tmp/claude-501/p/${OTHER_SESSION}/tasks/x.output` },
      SESSION,
    );
    expect(res.timedOut).toBeFalsy();
    expect(res.blocked).toBe(true);
  });

  it("enforce-read-provenance lets the session read an image pasted into it", async () => {
    const res = await callHook(
      "read/enforce-read-provenance.mjs",
      "Read",
      { file_path: `${BASE}/images/2.png` },
      SESSION,
    );
    expect(res.timedOut).toBeFalsy();
    expect(res.code).not.toBe(2);
  });

  it("enforce-read-provenance still blocks ANOTHER session's image", async () => {
    const res = await callHook(
      "read/enforce-read-provenance.mjs",
      "Read",
      { file_path: `/private/tmp/claude-501/p/${OTHER_SESSION}/images/2.png` },
      SESSION,
    );
    expect(res.timedOut).toBeFalsy();
    expect(res.code).toBe(2);
  });

  it("redirect-grep-to-agent lets the session grep its own output", async () => {
    const res = await callHook(
      "read/redirect-grep-to-agent.mjs",
      "Grep",
      { pattern: "FAIL", path: `${BASE}/tasks` },
      SESSION,
    );
    expect(res.timedOut).toBeFalsy();
    expect(res.blocked).toBe(false);
  });

  // redirect-read-to-agent does NOT govern this path class — it exits early for
  // anything outside PROJECT_DIR, and every harness output path is outside the
  // project. That is why no carve-out was added there: it would be dead code.
  // Pinned by BEHAVIOUR so a future refactor of that early exit fails loudly
  // rather than silently changing the allowance.
  //
  // NOTE: this hook NEVER exits 2 — every one of its exits is exit(0), and it
  // denies by writing a permissionDecision:"deny" payload to stdout. Do not use
  // callHook(...).blocked here; that field is `code === 2` and is always false
  // for this hook. The tests above may keep using it for
  // enforce-read-provenance, which does exit 2.
  const isDeny = (r) => (r.stdout || "").includes('"permissionDecision":"deny"');

  it("redirect-read-to-agent lets a harness path through without a deny payload", async () => {
    const res = await callHook(
      "read/redirect-read-to-agent.mjs",
      "Read",
      { file_path: `${BASE}/tasks/x.output` },
      SESSION,
    );
    expect(res.timedOut).toBeFalsy();
    expect(res.code).toBe(0);
    expect(isDeny(res)).toBe(false);
  });

  it("redirect-read-to-agent lets a pasted-image path through without a deny payload", async () => {
    const res = await callHook(
      "read/redirect-read-to-agent.mjs",
      "Read",
      { file_path: `${BASE}/images/2.png` },
      SESSION,
    );
    expect(res.timedOut).toBeFalsy();
    expect(res.code).toBe(0);
    expect(isDeny(res)).toBe(false);
  });

  it("redirect-read-to-agent DOES deny an in-project discovery read", async () => {
    // The contrast case: without it, "exits 0" proves nothing about a hook that
    // exits 0 on every path. A temp CLAUDE_PROJECT_DIR keeps this independent of
    // ambient repo state — no breadcrumb, no active-scope.json, no session state.
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rks-readboundary-"));
    try {
      fs.mkdirSync(path.join(tmpRoot, "notes"), { recursive: true });
      fs.writeFileSync(path.join(tmpRoot, "notes", "some-explore.md"), "# x\n");
      const res = await callHook(
        "read/redirect-read-to-agent.mjs",
        "Read",
        { file_path: path.join(tmpRoot, "notes", "some-explore.md") },
        SESSION,
        { CLAUDE_PROJECT_DIR: tmpRoot },
      );
      expect(res.timedOut).toBeFalsy();
      expect(isDeny(res)).toBe(true);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  // DELIBERATELY NOT ASSERTED HERE: "redirect-grep-to-agent blocks a codebase
  // search". That hook has three environment-dependent early exits before its
  // deny — isPathInActiveScope (true whenever an off-rail session's scope
  // contains the search path), and the Research-Agent outage fallthrough (true
  // for 5 minutes after any infra-class research failure). An assertion on the
  // deny path is therefore green or red depending on ambient session state, not
  // on this change. The equivalent negative IS asserted deterministically one
  // layer down, in "carves Grep out at rule 7, which sits BEFORE the write
  // ledger" — a project path still returns matchedRule 'patternSearchTool'.
});

describe("documentation names the images leaf", () => {
  it("CLAUDE.md's session-output exception note lists images in the path pattern", () => {
    const md = fs.readFileSync(path.join(PROJECT_ROOT, "CLAUDE.md"), "utf8");
    expect(md).toContain("<harness-root>/<session-id>/{tasks,scratchpad,tool-results,images}/");
  });

  it("CLAUDE.md carve-out 3 mentions images the user pasted into this session", () => {
    const md = fs.readFileSync(path.join(PROJECT_ROOT, "CLAUDE.md"), "utf8");
    const line = md.split("\n").find((l) => l.startsWith("3. **This session's own harness output**"));
    expect(line, "carve-out 3 not found").toBeTruthy();
    expect(line).toContain("images the user pasted into this session");
  });

  it("redirect-read-to-agent.mjs header lists images among the session's harness output", () => {
    for (const rel of [
      "packages/hooks/read/redirect-read-to-agent.mjs",
      ".routekit/hooks/read/redirect-read-to-agent.mjs",
      "templates/generic/.routekit/hooks/read/redirect-read-to-agent.mjs",
    ]) {
      const abs = path.join(PROJECT_ROOT, rel);
      // .routekit/hooks/read is relocated during an off-rail session.
      if (!fs.existsSync(abs)) continue;
      expect(fs.readFileSync(abs, "utf8"), rel).toContain(
        " * - This session's own harness output (tasks / scratchpad / tool-results / images)\n",
      );
    }
  });
});
