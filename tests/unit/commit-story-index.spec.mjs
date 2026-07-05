/**
 * Tests for buildCommitStoryIndex
 * (backlog.feat.commit-story-index)
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { buildCommitStoryIndex } from "../../packages/mcp-rks/src/server/telemetry/commit-story-index.mjs";

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "commit-story-index-test-"));
}

function writeTelemetryEvent(tmpDir, event) {
  const dir = path.join(tmpDir, ".rks", "telemetry");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "events-2026-01-01.jsonl");
  fs.appendFileSync(file, JSON.stringify(event) + "\n");
}

function writeAuditEntry(tmpDir, entry) {
  const logPath = path.join(tmpDir, ".rks", "guardrails-off-sessions.jsonl");
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.appendFileSync(logPath, JSON.stringify(entry) + "\n");
}

describe("buildCommitStoryIndex — source 1: commit-message", () => {
  let tmpDir;

  beforeEach(() => { tmpDir = makeTempDir(); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it("extracts storyId from 'chore: mark <problemId> as implemented'", () => {
    const commits = [
      { sha: "aabbccdd", message: "chore: mark backlog.feat.my-story as implemented" },
    ];
    const index = buildCommitStoryIndex(tmpDir, { commits });
    const entry = index.get("aabbccdd");
    expect(entry).toBeDefined();
    expect(entry.storyId).toBe("backlog.feat.my-story");
    expect(entry.source).toBe("commit-message");
    expect(entry.flowType).toBe("maintenance");
  });

  it("does NOT extract storyId from commit messages that don't match the pattern", () => {
    const commits = [
      { sha: "aabbccdd", message: "feat: add something cool to backlog.feat.my-story" },
    ];
    const index = buildCommitStoryIndex(tmpDir, { commits });
    const entry = index.get("aabbccdd");
    expect(entry.storyId).toBeNull();
    expect(entry.source).toBeNull();
  });

  it("does NOT extract storyId from 'chore: update <thing>' without 'as implemented'", () => {
    const commits = [
      { sha: "aabbccdd", message: "chore: update backlog.feat.my-story dependencies" },
    ];
    const index = buildCommitStoryIndex(tmpDir, { commits });
    expect(index.get("aabbccdd").storyId).toBeNull();
  });
});

describe("buildCommitStoryIndex — source 2: pr-merged telemetry", () => {
  let tmpDir;

  beforeEach(() => { tmpDir = makeTempDir(); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it("returns { storyId, source: 'pr-merged' } for commitSha present in pr.merged event", () => {
    writeTelemetryEvent(tmpDir, {
      id: "ev-1",
      type: "pr.merged",
      timestamp: "2026-01-01T00:00:00Z",
      projectId: "routekit-shell",
      correlationId: null,
      runId: null,
      payload: { prNumber: 42, commitId: "deadbeef", problemId: "backlog.feat.pr-story", reason: null, mode: "linked" },
      context: {},
    });

    const commits = [{ sha: "deadbeef", message: "feat: some feature" }];
    const index = buildCommitStoryIndex(tmpDir, { commits });
    const entry = index.get("deadbeef");
    expect(entry.storyId).toBe("backlog.feat.pr-story");
    expect(entry.source).toBe("pr-merged");
  });

  it("matches when telemetry commitId is a short SHA prefix of the commit sha", () => {
    writeTelemetryEvent(tmpDir, {
      id: "ev-2",
      type: "pr.merged",
      timestamp: "2026-01-01T00:00:00Z",
      projectId: "routekit-shell",
      correlationId: null,
      runId: null,
      payload: { prNumber: 43, commitId: "deadbeef", problemId: "backlog.feat.short-sha", reason: null, mode: "linked" },
      context: {},
    });

    const commits = [{ sha: "deadbeeffeedcafe", message: "feat: long sha commit" }];
    const index = buildCommitStoryIndex(tmpDir, { commits });
    const entry = index.get("deadbeeffeedcafe");
    expect(entry.storyId).toBe("backlog.feat.short-sha");
    expect(entry.source).toBe("pr-merged");
  });

  it("produces no entry (storyId: null) for commits absent from pr.merged events", () => {
    writeTelemetryEvent(tmpDir, {
      id: "ev-3",
      type: "pr.merged",
      timestamp: "2026-01-01T00:00:00Z",
      projectId: "routekit-shell",
      correlationId: null,
      runId: null,
      payload: { prNumber: 44, commitId: "aaaaaaaabbbbbbbb", problemId: "backlog.feat.other", reason: null, mode: "linked" },
      context: {},
    });

    const commits = [{ sha: "ccccccccdddddddd", message: "feat: unrelated commit" }];
    const index = buildCommitStoryIndex(tmpDir, { commits });
    expect(index.get("ccccccccdddddddd").storyId).toBeNull();
  });
});

describe("buildCommitStoryIndex — source 3: audit-log", () => {
  let tmpDir;

  beforeEach(() => { tmpDir = makeTempDir(); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it("returns { storyId, source: 'audit-log' } for feat(off-rail) commit with Session: footer matching audit log", () => {
    writeAuditEntry(tmpDir, {
      sessionId: "sess-abc-123",
      startedAt: "2026-01-01T00:00:00Z",
      reason: "build story",
      problemId: "backlog.feat.audit-story",
    });

    const message = [
      "feat(off-rail): build audit story",
      "",
      "Session: sess-abc-123",
      "Duration: 5m",
      "Files: 3",
    ].join("\n");

    const commits = [{ sha: "11112222", message }];
    const index = buildCommitStoryIndex(tmpDir, { commits });
    const entry = index.get("11112222");
    expect(entry.storyId).toBe("backlog.feat.audit-story");
    expect(entry.source).toBe("audit-log");
    expect(entry.flowType).toBe("off_rail");
  });

  it("returns { storyId, source: 'audit-log' } for commit with Story: footer (explicit)", () => {
    const message = [
      "feat(off-rail): build some story",
      "",
      "Session: sess-xyz-999",
      "Story: backlog.feat.explicit-story",
      "Duration: 2m",
    ].join("\n");

    const commits = [{ sha: "33334444", message }];
    const index = buildCommitStoryIndex(tmpDir, { commits });
    const entry = index.get("33334444");
    expect(entry.storyId).toBe("backlog.feat.explicit-story");
    expect(entry.source).toBe("audit-log");
  });

  it("returns storyId: null when Session: footer sessionId is not in audit log", () => {
    writeAuditEntry(tmpDir, {
      sessionId: "different-session",
      startedAt: "2026-01-01T00:00:00Z",
      problemId: "backlog.feat.other",
    });

    const message = "feat(off-rail): some work\n\nSession: untracked-session\n";
    const commits = [{ sha: "55556666", message }];
    const index = buildCommitStoryIndex(tmpDir, { commits });
    expect(index.get("55556666").storyId).toBeNull();
  });
});

describe("buildCommitStoryIndex — null fallback", () => {
  let tmpDir;

  beforeEach(() => { tmpDir = makeTempDir(); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it("returns { storyId: null, flowType: <bucket> } when no source matches", () => {
    const commits = [
      { sha: "aaaaaaaa", message: "fix: some bug fix" },
      { sha: "bbbbbbbb", message: "docs: update readme" },
      { sha: "cccccccc", message: "feat: new feature" },
    ];
    const index = buildCommitStoryIndex(tmpDir, { commits });
    expect(index.get("aaaaaaaa")).toMatchObject({ storyId: null, source: null, flowType: "fix" });
    expect(index.get("bbbbbbbb")).toMatchObject({ storyId: null, source: null, flowType: "docs" });
    expect(index.get("cccccccc")).toMatchObject({ storyId: null, source: null, flowType: "feature" });
  });

  it("returns empty map when no commits provided", () => {
    const index = buildCommitStoryIndex(tmpDir, { commits: [] });
    expect(index.size).toBe(0);
  });
});

describe("buildCommitStoryIndex — source priority ordering", () => {
  let tmpDir;

  beforeEach(() => { tmpDir = makeTempDir(); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it("source 1 (commit-message) takes priority over source 2 (pr-merged)", () => {
    writeTelemetryEvent(tmpDir, {
      id: "ev-p1",
      type: "pr.merged",
      timestamp: "2026-01-01T00:00:00Z",
      projectId: "routekit-shell",
      correlationId: null,
      runId: null,
      payload: { prNumber: 1, commitId: "priority-sha", problemId: "backlog.feat.pr-story", reason: null, mode: "linked" },
      context: {},
    });

    const message = "chore: mark backlog.feat.msg-story as implemented\n\n#off-rail-work";
    const commits = [{ sha: "priority-sha", message }];
    const index = buildCommitStoryIndex(tmpDir, { commits });
    expect(index.get("priority-sha").storyId).toBe("backlog.feat.msg-story");
    expect(index.get("priority-sha").source).toBe("commit-message");
  });

  it("source 2 (pr-merged) takes priority over source 3 (audit-log)", () => {
    writeTelemetryEvent(tmpDir, {
      id: "ev-p2",
      type: "pr.merged",
      timestamp: "2026-01-01T00:00:00Z",
      projectId: "routekit-shell",
      correlationId: null,
      runId: null,
      payload: { prNumber: 2, commitId: "sha-for-prio", problemId: "backlog.feat.pr-wins", reason: null, mode: "linked" },
      context: {},
    });

    writeAuditEntry(tmpDir, {
      sessionId: "session-prio-test",
      problemId: "backlog.feat.audit-loses",
    });

    const message = "feat(off-rail): priority test\n\nSession: session-prio-test\n";
    const commits = [{ sha: "sha-for-prio", message }];
    const index = buildCommitStoryIndex(tmpDir, { commits });
    expect(index.get("sha-for-prio").storyId).toBe("backlog.feat.pr-wins");
    expect(index.get("sha-for-prio").source).toBe("pr-merged");
  });
});

describe("guardrails-audit.mjs commit footer Story field", () => {
  it("includes 'Story: <problemId>' line in the story footer constant", () => {
    const auditSource = fs.readFileSync(
      path.resolve(process.cwd(), "packages/mcp-rks/src/server/guardrails-audit.mjs"),
      "utf8"
    );
    // The footer now conditionally adds Story: line
    expect(auditSource).toContain("Story: ${activeSession.problemId}");
  });

  it("omits Story line when no problemId (storyLine is empty string)", () => {
    const auditSource = fs.readFileSync(
      path.resolve(process.cwd(), "packages/mcp-rks/src/server/guardrails-audit.mjs"),
      "utf8"
    );
    // Guards with a ternary — empty string when no problemId
    expect(auditSource).toContain('activeSession.problemId ? ');
    expect(auditSource).toContain(': ""');
  });
});
