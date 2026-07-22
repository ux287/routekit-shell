import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { makeTempDir } from "../../helpers/tmp.mjs";
import { buildCommitStoryIndex } from "../../../packages/mcp-rks/src/server/telemetry/commit-story-index.mjs";

const dirs = [];
afterEach(() => {
  for (const d of dirs.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

function makeRoot() {
  const root = makeTempDir("commit-story-index");
  dirs.push(root);
  fs.mkdirSync(path.join(root, ".rks", "telemetry"), { recursive: true });
  return root;
}

function writePrMergedEvent(root, { commitId, problemId, date = "2026-05-02" }) {
  const file = path.join(root, ".rks", "telemetry", `events-${date}.jsonl`);
  const event = JSON.stringify({ type: "pr.merged", payload: { commitId, problemId } });
  fs.appendFileSync(file, event + "\n");
}

function writeAuditLog(root, entries) {
  const logPath = path.join(root, ".rks", "guardrails-off-sessions.jsonl");
  for (const entry of entries) {
    fs.appendFileSync(logPath, JSON.stringify(entry) + "\n");
  }
}

describe("buildCommitStoryIndex — source 1: commit-message", () => {
  it("extracts storyId from 'chore: mark <problemId> as implemented' message", () => {
    const root = makeRoot();
    const index = buildCommitStoryIndex(root, {
      commits: [{ sha: "abc1", message: "chore: mark backlog.feat.my-story as implemented" }],
    });
    const entry = index.get("abc1");
    expect(entry.storyId).toBe("backlog.feat.my-story");
    expect(entry.source).toBe("commit-message");
    expect(entry.flowType).toBe("maintenance");
  });

  it("does NOT extract storyId from messages that don't match the pattern", () => {
    const root = makeRoot();
    const index = buildCommitStoryIndex(root, {
      commits: [{ sha: "abc2", message: "feat: add some feature" }],
    });
    const entry = index.get("abc2");
    expect(entry.storyId).toBeNull();
    expect(entry.source).toBeNull();
  });
});

describe("buildCommitStoryIndex — source 2: pr.merged telemetry", () => {
  it("returns storyId and source=pr-merged for a commit present in pr.merged events", () => {
    const root = makeRoot();
    writePrMergedEvent(root, { commitId: "deadbeef", problemId: "backlog.feat.pr-story" });
    const index = buildCommitStoryIndex(root, {
      commits: [{ sha: "deadbeef", message: "feat: some change" }],
    });
    const entry = index.get("deadbeef");
    expect(entry.storyId).toBe("backlog.feat.pr-story");
    expect(entry.source).toBe("pr-merged");
  });

  it("produces null storyId for commits absent from pr.merged events", () => {
    const root = makeRoot();
    writePrMergedEvent(root, { commitId: "aaaaaaaa", problemId: "backlog.feat.other" });
    const index = buildCommitStoryIndex(root, {
      commits: [{ sha: "bbbbbbbb", message: "feat: unrelated" }],
    });
    const entry = index.get("bbbbbbbb");
    expect(entry.storyId).toBeNull();
  });
});

describe("buildCommitStoryIndex — source 3: audit-log", () => {
  it("resolves storyId via Story: footer matching audit log", () => {
    const root = makeRoot();
    writeAuditLog(root, [{ sessionId: "sess-111", problemId: "backlog.feat.audit-story" }]);
    const index = buildCommitStoryIndex(root, {
      commits: [{
        sha: "cccc1111",
        message: "feat(off-rail): build story\n\nSession: sess-111\nStory: backlog.feat.audit-story",
      }],
    });
    const entry = index.get("cccc1111");
    expect(entry.storyId).toBe("backlog.feat.audit-story");
    expect(entry.source).toBe("audit-log");
  });

  it("resolves storyId via Session: footer lookup in audit log when Story: absent", () => {
    const root = makeRoot();
    writeAuditLog(root, [{ sessionId: "sess-222", problemId: "backlog.feat.session-story" }]);
    const index = buildCommitStoryIndex(root, {
      commits: [{
        sha: "dddd2222",
        message: "feat(off-rail): build story\n\nSession: sess-222",
      }],
    });
    const entry = index.get("dddd2222");
    expect(entry.storyId).toBe("backlog.feat.session-story");
    expect(entry.source).toBe("audit-log");
    expect(entry.flowType).toBe("off_rail");
  });
});

describe("buildCommitStoryIndex — null/non-story fallback", () => {
  it("returns storyId:null and valid flowType bucket for unmatched commits", () => {
    const root = makeRoot();
    const index = buildCommitStoryIndex(root, {
      commits: [{ sha: "eeee3333", message: "docs: update readme" }],
    });
    const entry = index.get("eeee3333");
    expect(entry.storyId).toBeNull();
    expect(entry.source).toBeNull();
    expect(entry.flowType).toBe("docs");
  });

  it("returns empty map for empty commits array", () => {
    const root = makeRoot();
    const index = buildCommitStoryIndex(root, { commits: [] });
    expect(index.size).toBe(0);
  });
});

describe("buildCommitStoryIndex — source priority", () => {
  it("source 1 takes priority over source 2 when both match", () => {
    const root = makeRoot();
    writePrMergedEvent(root, { commitId: "ffff4444", problemId: "backlog.feat.source2-story" });
    const index = buildCommitStoryIndex(root, {
      commits: [{
        sha: "ffff4444",
        message: "chore: mark backlog.feat.source1-story as implemented",
      }],
    });
    const entry = index.get("ffff4444");
    expect(entry.storyId).toBe("backlog.feat.source1-story");
    expect(entry.source).toBe("commit-message");
  });

  it("source 2 takes priority over source 3 when both match", () => {
    const root = makeRoot();
    writePrMergedEvent(root, { commitId: "gggg5555", problemId: "backlog.feat.source2-wins" });
    writeAuditLog(root, [{ sessionId: "sess-333", problemId: "backlog.feat.source3-story" }]);
    const index = buildCommitStoryIndex(root, {
      commits: [{
        sha: "gggg5555",
        message: "feat(off-rail): build\n\nSession: sess-333",
      }],
    });
    const entry = index.get("gggg5555");
    expect(entry.storyId).toBe("backlog.feat.source2-wins");
    expect(entry.source).toBe("pr-merged");
  });
});
