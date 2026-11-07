/**
 * Tests for backlog.fix.orphaned-embed-subprocess-fanout.
 *
 * `writeNoteRaw` used to end by launching a DETACHED child process running
 * packages/rag/src/embed.mjs, then unref-ing it — with NO file arguments.
 * (The call syntax is deliberately not reproduced here: this file lives under
 * tests/unit/, where the purity guard scans for spawn-family call syntax and
 * does not strip block comments.)
 *
 * embed.mjs filters argv for `--files=` and otherwise
 * falls back to a FULL-CORPUS re-index (lancedb + transformers), so every single
 * note write launched a complete re-embed: ~175-205MB RSS, minutes of runtime,
 * detached into its own process group, unkillable, silent. There was no lock —
 * checkEmbedLock lives inside runRagEmbed, which this CLI spawn never enters.
 *
 * Observed: load average 583, dozens of PID-1 orphans alive 20+ minutes. Six
 * bare writeNoteRaw calls in the unit tier were launching them inside CI itself,
 * against maxForks: 2 on a runner with ~203MB free and swap at 91%.
 *
 * THE TRAP THIS FILE IS BUILT AROUND: the spawn is deferred into
 * `import(...).then()`, so it fires AFTER writeNoteRaw returns. A test that
 * asserts "spawn was not called" right after the call PASSES AGAINST THE BROKEN
 * CODE. Every negative here is therefore paired with a positive control through
 * the identical seam — if the control does not observe a spawn, the negative
 * proves nothing.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

/**
 * A handle that behaves like a real child: it EXITS. Without that the
 * single-flight latch never releases, and every later assertion in the file
 * silently measures a suppressed spawn rather than the behaviour under test.
 */
function makeChild() {
  return {
    unref: vi.fn(),
    kill: vi.fn(),
    on: vi.fn((event, cb) => {
      if (event === "exit") cb(0);
    }),
  };
}

const spawnMock = vi.fn(() => makeChild());

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
  default: { spawn: spawnMock },
}));

const { writeNoteRaw, embedSettled } = await import(
  "../../packages/mcp-rks/src/dendron.mjs"
);

let dir = null;
let savedVitest;
let savedOptOut;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "rks-embed-bound-"));
  spawnMock.mockClear();
  savedVitest = process.env.VITEST;
  savedOptOut = process.env.RKS_SKIP_BACKGROUND_EMBED;
});

afterEach(async () => {
  await embedSettled();
  if (savedVitest === undefined) delete process.env.VITEST;
  else process.env.VITEST = savedVitest;
  if (savedOptOut === undefined) delete process.env.RKS_SKIP_BACKGROUND_EMBED;
  else process.env.RKS_SKIP_BACKGROUND_EMBED = savedOptOut;
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
});

const notePath = (name = "n.md") => path.join(dir, name);

/** Drop the test-env guard so the real spawn path runs against the mock. */
function enableBackgroundEmbed() {
  delete process.env.VITEST;
  delete process.env.RKS_SKIP_BACKGROUND_EMBED;
}

describe("positive control — the seam actually observes a spawn", () => {
  it("records a spawn once the guard is lifted and the microtask flushes", async () => {
    // Without this passing, every negative assertion in this file is vacuous.
    enableBackgroundEmbed();
    writeNoteRaw(notePath(), "# hi\n");
    await embedSettled();
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("proves the microtask has NOT flushed before embedSettled resolves", async () => {
    // This is the trap: asserting immediately would pass against broken code.
    enableBackgroundEmbed();
    writeNoteRaw(notePath(), "# hi\n");
    expect(spawnMock).not.toHaveBeenCalled(); // still deferred
    await embedSettled();
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });
});

describe("no full-corpus re-embed", () => {
  it("passes the written note as --files=, never a bare positional path", async () => {
    enableBackgroundEmbed();
    const p = notePath();
    writeNoteRaw(p, "# hi\n");
    await embedSettled();

    const [, args] = spawnMock.mock.calls[0];
    expect(args[0]).toBe("packages/rag/src/embed.mjs");
    // embed.mjs matches `--files=` exactly; anything else means incrementalFiles
    // stays null and it re-indexes the whole corpus.
    expect(args.some((a) => a === p)).toBe(false);
    expect(args).toContain(`--files=${p}`);
  });

  it("never invokes embed.mjs with no file arguments at all", async () => {
    enableBackgroundEmbed();
    writeNoteRaw(notePath(), "# hi\n");
    await embedSettled();
    const [, args] = spawnMock.mock.calls[0];
    expect(args.filter((a) => String(a).startsWith("--files=")).length)
      .toBeGreaterThan(0);
  });
});

describe("the child cannot outlive the run", () => {
  it("does not detach the child into its own process group", async () => {
    // detached:true is why a signal to the parent's group never reached these
    // and why they survived as PID-1 orphans.
    enableBackgroundEmbed();
    writeNoteRaw(notePath(), "# hi\n");
    await embedSettled();
    const [, , opts] = spawnMock.mock.calls[0];
    expect(opts.detached).not.toBe(true);
  });

  it("still keeps the child off the event loop", async () => {
    enableBackgroundEmbed();
    const handle = makeChild();
    spawnMock.mockReturnValueOnce(handle);
    writeNoteRaw(notePath(), "# hi\n");
    await embedSettled();
    expect(handle.unref).toHaveBeenCalled();
  });

  it("arms a kill timer bounding the child's lifetime", async () => {
    enableBackgroundEmbed();
    const handle = makeChild();
    spawnMock.mockReturnValueOnce(handle);
    writeNoteRaw(notePath(), "# hi\n");
    await embedSettled();
    // exit and error both clear it; both must be wired or the timer leaks.
    const events = handle.on.mock.calls.map(([e]) => e);
    expect(events).toContain("exit");
    expect(events).toContain("error");
  });
});

describe("bounded fan-out — a burst collapses to one embedder", () => {
  it("spawns once across many writes while one is in flight", async () => {
    enableBackgroundEmbed();
    for (let i = 0; i < 12; i++) writeNoteRaw(notePath(`n${i}.md`), `# ${i}\n`);
    await embedSettled();
    // Pre-fix this was 12 concurrent full-corpus embedders.
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });
});

describe("writes never block on embedding", () => {
  it("returns promptly even when the spawn seam is slow", async () => {
    enableBackgroundEmbed();
    const started = Date.now();
    writeNoteRaw(notePath(), "# hi\n");
    expect(Date.now() - started).toBeLessThan(250);
    await embedSettled();
  });

  it("still writes the file when embedding is skipped entirely", () => {
    const p = notePath();
    writeNoteRaw(p, "# content\n"); // VITEST is set — guard active
    expect(fs.readFileSync(p, "utf8")).toBe("# content\n");
    expect(spawnMock).not.toHaveBeenCalled();
  });
});

describe("no embedder is spawned from a test run", () => {
  it("skips under VITEST", async () => {
    process.env.VITEST = "true";
    writeNoteRaw(notePath(), "# hi\n");
    await embedSettled();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("skips under the explicit opt-out", async () => {
    delete process.env.VITEST;
    process.env.RKS_SKIP_BACKGROUND_EMBED = "1";
    writeNoteRaw(notePath(), "# hi\n");
    await embedSettled();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("evaluates the guard at call time, not at module load", async () => {
    // A module-scope const would be frozen by vi.mock hoisting, and every
    // negative in this file would become unfalsifiable.
    process.env.VITEST = "true";
    writeNoteRaw(notePath("a.md"), "a\n");
    await embedSettled();
    expect(spawnMock).not.toHaveBeenCalled();

    delete process.env.VITEST;
    writeNoteRaw(notePath("b.md"), "b\n");
    await embedSettled();
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });
});

describe("skipEmbed still short-circuits ahead of everything", () => {
  it("does not spawn when the caller drives the embed itself", async () => {
    enableBackgroundEmbed();
    writeNoteRaw(notePath(), "# hi\n", { skipEmbed: true });
    await embedSettled();
    expect(spawnMock).not.toHaveBeenCalled();
  });
});
