import { describe, it, expect, vi } from "vitest";
import path from "node:path";
import { handlePublishCommand } from "../../packages/cli/src/cli/publish.js";

// Dispatch contract for `routekit publish`. All side effects are DI-mocked — no git, no
// network, no real publish(). Verifies flag→options mapping, the --yes force-push gate,
// default remote resolution, projectRoot resolution, and exit codes.

const SHELL_ROOT = "/tmp/shell";

function makeDeps(over = {}) {
  return {
    publish: vi.fn(async () => ({ ok: true, message: "Published to rks-public/main" })),
    loadPublishProfiles: vi.fn(() => ({ remotes: { "rks-public": { profile: "rks-public", branch: "main" } } })),
    getRemoteConfig: vi.fn(() => ({ profile: "rks-public", branch: "main" })),
    processExit: vi.fn(),
    log: vi.fn(),
    errorLog: vi.fn(),
    ...over,
  };
}
const run = (kv = {}, args = [], over = {}) => {
  const deps = makeDeps(over);
  return handlePublishCommand({ kv, args, SHELL_ROOT }, deps).then(() => deps);
};

describe("routekit publish — dispatch", () => {
  it("maps flags to publish() options and defaults projectRoot to cwd", async () => {
    const deps = await run({ remote: "rks-public", profile: "rks-public", branch: "main", message: "fix", yes: true });
    expect(deps.publish).toHaveBeenCalledOnce();
    const [projectRoot, opts] = deps.publish.mock.calls[0];
    expect(projectRoot).toBe(process.cwd());
    expect(opts).toEqual(expect.objectContaining({ remote: "rks-public", profile: "rks-public", branch: "main", message: "fix", dryRun: false }));
    expect(deps.processExit).toHaveBeenCalledWith(0);
  });

  it("supports -m <msg> parsed from raw args", async () => {
    const deps = await run({ yes: true }, ["publish", "-m", "hello world"]);
    expect(deps.publish.mock.calls[0][1].message).toBe("hello world");
  });

  it("--dry-run passes dryRun:true, needs NO --yes, exits 0", async () => {
    const deps = await run({ "dry-run": true }, [], {
      publish: vi.fn(async () => ({ ok: true, includePatterns: ["a", "b"], identity: { from: "routekit-shell-core", to: "routekit-shell" } })),
    });
    expect(deps.publish).toHaveBeenCalledOnce();
    expect(deps.publish.mock.calls[0][1].dryRun).toBe(true);
    expect(deps.processExit).toHaveBeenCalledWith(0);
  });

  it("REFUSES a real (non-dry-run) publish without --yes — publish() not called, non-zero exit", async () => {
    const deps = await run({ remote: "rks-public" });
    expect(deps.publish).not.toHaveBeenCalled();
    expect(deps.processExit.mock.calls[0][0]).not.toBe(0);
  });

  it("proceeds with --yes on a real publish and exits 0 on {ok:true}", async () => {
    const deps = await run({ remote: "rks-public", yes: true });
    expect(deps.publish).toHaveBeenCalledOnce();
    expect(deps.publish.mock.calls[0][1].dryRun).toBe(false);
    expect(deps.processExit).toHaveBeenCalledWith(0);
  });

  it("defaults to the single configured remote when --remote omitted", async () => {
    const deps = await run({ yes: true });
    expect(deps.publish.mock.calls[0][1].remote).toBe("rks-public");
  });

  it("errors (usage + non-zero) when multiple remotes and no --remote — publish() not called", async () => {
    const deps = await run({ yes: true }, [], {
      loadPublishProfiles: vi.fn(() => ({ remotes: { "rks-public": {}, other: {} } })),
    });
    expect(deps.publish).not.toHaveBeenCalled();
    expect(deps.processExit.mock.calls[0][0]).not.toBe(0);
  });

  it("errors when no remotes are configured — publish() not called", async () => {
    const deps = await run({ yes: true }, [], { loadPublishProfiles: vi.fn(() => ({ remotes: {} })) });
    expect(deps.publish).not.toHaveBeenCalled();
    expect(deps.processExit.mock.calls[0][0]).not.toBe(0);
  });

  it("exit 1 + surfaces error when publish() returns {ok:false}", async () => {
    const deps = await run({ remote: "rks-public", yes: true }, [], {
      publish: vi.fn(async () => ({ ok: false, error: "no ssh key" })),
    });
    expect(deps.processExit).toHaveBeenCalledWith(1);
    expect(deps.errorLog.mock.calls.flat().join(" ")).toMatch(/no ssh key/);
  });

  it("exit 1 when publish() throws (failure not swallowed)", async () => {
    const deps = await run({ remote: "rks-public", yes: true }, [], {
      publish: vi.fn(async () => {
        throw new Error("boom");
      }),
    });
    expect(deps.processExit).toHaveBeenCalledWith(1);
    expect(deps.errorLog.mock.calls.flat().join(" ")).toMatch(/boom/);
  });

  it("existence-guards --root: nonexistent path → usage + non-zero, publish() not called", async () => {
    const deps = await run({ root: "/no/such/dir/at/all", yes: true });
    expect(deps.publish).not.toHaveBeenCalled();
    expect(deps.processExit.mock.calls[0][0]).not.toBe(0);
  });

  it("uses a valid --root override as projectRoot", async () => {
    const deps = await run({ root: process.cwd(), yes: true });
    expect(deps.publish.mock.calls[0][0]).toBe(path.resolve(process.cwd()));
  });
});
