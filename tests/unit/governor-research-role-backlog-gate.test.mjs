import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import * as governorToken from "../../packages/mcp-rks/src/shared/governor-token.mjs";
import { openBacklogCreateRefusal } from "../../packages/mcp-rks/src/shared/admission-table.mjs";
import { handleGovernorInit, INPUT_SCHEMA } from "../../packages/mcp-rks/src/tools/governor-init.mjs";
import { TOOL_ARG_SCHEMAS } from "../../packages/mcp-rks/src/server.mjs";

// backlog.fix.open-flow-research-session-backlog-create-gate.
// Session setup and chain advance follow tests/unit/dendron-write-arg-checks-close-bypasses.test.mjs
// (createSession + advanceState + checkAllowedTool). Init tests call handleGovernorInit the way
// tests/unit/governor-init-session-isolation.test.mjs does.

const { createSession, getSession, getToken, checkAllowedTool, advanceState, setProjectRoot, resetToken } = governorToken;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const BACKLOG = "backlog.feat.x";
const Z_ARCHIVE = "z_archive.backlog.feat.x";
const RESEARCH_NAMES = ["research.2026.11.19.topic", "design.topic", "notes.topic"];

let tmpRoot;
beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "grrbg-"));
  setProjectRoot(tmpRoot);
  resetToken();
});
afterEach(() => {
  resetToken();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

const createCall = (session, filename) => ({ tool: "dendron_create_note", args: { filename }, session });
const editCall = (session, filename) => ({ tool: "dendron_edit_note", args: { filename }, session });
const openSession = (extra = {}) => ({ flowType: "open", state: "writing", ...extra });

describe("openBacklogCreateRefusal research role", () => {
  it("refuses a backlog create for a research-role open session even when openBacklogCreateAdmitted", () => {
    const refusal = openBacklogCreateRefusal(createCall(openSession({ role: "research", openBacklogCreateAdmitted: true }), BACKLOG));
    expect(refusal).toMatchObject({ error: "namespace_violation" });
    expect(refusal.message).toMatch(/role 'research'/);
  });

  it("admits research, design and notes creates and backlog edits for a research-role session", () => {
    const session = openSession({ role: "research", openBacklogCreateAdmitted: true });
    for (const filename of RESEARCH_NAMES) {
      expect(openBacklogCreateRefusal(createCall(session, filename)), filename).toBeNull();
    }
    expect(openBacklogCreateRefusal(editCall(session, BACKLOG))).toBeNull();
  });

  it("refuses a z_archive create for a research-role open session and names z_archive", () => {
    for (const extra of [{}, { openBacklogCreateAdmitted: true }]) {
      const refusal = openBacklogCreateRefusal(createCall(openSession({ role: "research", ...extra }), Z_ARCHIVE));
      expect(refusal, JSON.stringify(extra)).toMatchObject({ error: "namespace_violation" });
      expect(refusal.message).toMatch(/z_archive/);
    }
  });

  it("still refuses a backlog create for a research-role session with a message naming backlog", () => {
    const refusal = openBacklogCreateRefusal(createCall(openSession({ role: "research" }), BACKLOG));
    expect(refusal).toMatchObject({ error: "namespace_violation" });
    expect(refusal.message).toMatch(/backlog/);
  });

  it("does not refuse a z_archive create for a role-less open session", () => {
    expect(openBacklogCreateRefusal(createCall(openSession(), Z_ARCHIVE))).toBeNull();
    expect(openBacklogCreateRefusal(createCall(openSession({ role: null }), Z_ARCHIVE))).toBeNull();
  });

  it("admits a z_archive edit for a research-role session", () => {
    expect(openBacklogCreateRefusal(editCall(openSession({ role: "research" }), Z_ARCHIVE))).toBeNull();
  });

  it("is unchanged for a role-less open session", () => {
    expect(openBacklogCreateRefusal(createCall(openSession(), BACKLOG))).toMatchObject({ error: "namespace_violation" });
    expect(openBacklogCreateRefusal(createCall(openSession({ role: null }), BACKLOG))).toMatchObject({ error: "namespace_violation" });
    expect(openBacklogCreateRefusal(createCall(openSession({ openBacklogCreateAdmitted: true }), BACKLOG))).toBeNull();
    expect(openBacklogCreateRefusal(createCall(openSession({ role: null, openBacklogCreateAdmitted: true }), BACKLOG))).toBeNull();
  });
});

describe("createSession role", () => {
  it("stores role research, and null when role is absent", () => {
    const withRole = createSession({ projectId: "routekit-shell-core", role: "research" }).token;
    expect(getSession(withRole).role).toBe("research");
    const without = createSession({ projectId: "routekit-shell-core" }).token;
    expect(getSession(without)).toHaveProperty("role", null);
  });
});

describe("rks_governor_init role", () => {
  // No session: the refused init left no active token, and an exclusive (qa) init on the same
  // project is not refused project_leased, so no lease was taken either.
  const expectNoSessionCreated = () => {
    expect(getToken()).toBeNull();
    const probe = handleGovernorInit({ projectId: "p", flowType: "qa", problemId: "story-probe" });
    expect(probe.ok).toBe(true);
  };

  it("accepts role research on open flow and echoes it", async () => {
    const res = handleGovernorInit({ projectId: "p", role: "research" });
    expect(res).toMatchObject({ ok: true, flowType: "open", role: "research" });
    expect(getSession(res.token).role).toBe("research");
    const plain = handleGovernorInit({ projectId: "p" });
    expect(plain).toMatchObject({ ok: true, flowType: "open", role: null });
    expect(getSession(plain.token).role).toBeNull();
  });

  it("refuses role research with a problemId", async () => {
    // Inferred flow (a problemId resolves to story) and an explicit flowType open: the problemId
    // alone must refuse the role, not only the non-open flowType it implies.
    for (const extra of [{}, { flowType: "open" }]) {
      const res = handleGovernorInit({ projectId: "p", role: "research", problemId: "backlog.feat.x", ...extra });
      expect(res.ok, JSON.stringify(extra)).toBe(false);
      expect(res.token).toBeUndefined();
    }
    expectNoSessionCreated();
  });

  it("refuses role research with a non-open flowType", async () => {
    const res = handleGovernorInit({ projectId: "p", role: "research", flowType: "qa" });
    expect(res.ok).toBe(false);
    expect(res.token).toBeUndefined();
    expectNoSessionCreated();
  });

  it("declares role enum research in both schemas and rejects an unknown role", () => {
    expect(INPUT_SCHEMA.properties.role.enum).toEqual(["research"]);
    expect(INPUT_SCHEMA.required).not.toContain("role");
    const schema = TOOL_ARG_SCHEMAS.rks_governor_init;
    expect(schema.parse({ projectId: "p", role: "research" }).role).toBe("research");
    expect(schema.safeParse({ projectId: "p", role: "po" }).success).toBe(false);
  });

  it("refuses an unknown role in the handler with role_not_admitted and creates no session", () => {
    const res = handleGovernorInit({ projectId: "p", role: "po" });
    expect(res).toMatchObject({ ok: false, reason: "role_not_admitted" });
    expect(res.message).toMatch(/is not a recognised session role/);
    expect(res.token).toBeUndefined();
    expectNoSessionCreated();
  });
});

describe("research-role chain admission", () => {
  const researchSessionInWriting = () => {
    const token = createSession({ projectId: "routekit-shell-core", role: "research" }).token;
    for (let i = 0; i < 6; i++) advanceState(token, "rks_agent_research");
    expect(getSession(token).state).toBe("writing");
    return token;
  };

  it("refuses a backlog create after six research calls into writing", () => {
    const token = researchSessionInWriting();
    expect(checkAllowedTool(token, "dendron_create_note", { filename: BACKLOG })).toMatchObject({ ok: false, error: "namespace_violation" });
  });

  it("refuses a z_archive create after six research calls into writing", () => {
    const token = researchSessionInWriting();
    expect(checkAllowedTool(token, "dendron_create_note", { filename: Z_ARCHIVE })).toMatchObject({ ok: false, error: "namespace_violation" });
  });

  it("admits research, design and notes create and edit after six research calls", () => {
    const token = researchSessionInWriting();
    for (const filename of RESEARCH_NAMES) {
      expect(checkAllowedTool(token, "dendron_create_note", { filename }), `create ${filename}`).toBeNull();
      expect(checkAllowedTool(token, "dendron_edit_note", { filename }), `edit ${filename}`).toBeNull();
    }
  });

  it("role-less PO traversal is still refused before and admitted after test-file-scanning", () => {
    const token = createSession({ projectId: "routekit-shell-core" }).token;
    expect(checkAllowedTool(token, "dendron_create_note", { filename: BACKLOG })).toMatchObject({ ok: false, error: "namespace_violation" });
    for (let i = 0; i < 3; i++) advanceState(token, "rks_agent_research");
    expect(getSession(token).state).toBe("test-file-scanning");
    expect(checkAllowedTool(token, "dendron_create_note", { filename: BACKLOG })).toBeNull();
  });
});

describe("governor-research.md step 0", () => {
  it("passes role research and keeps the NEVER create backlog line", () => {
    const src = fs.readFileSync(path.join(ROOT, ".rks/prompts/governor-research.md"), "utf8");
    expect(src).toMatch(/rks_governor_init\(\{[^}]*role:\s*'research'/);
    expect(src).toMatch(/NEVER create backlog\.\*/);
  });
});
