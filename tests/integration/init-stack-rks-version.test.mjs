import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { initProjectFromStack } from "../../packages/cli/src/project/init-stack.js";

// initProjectFromStack must stamp the child's .rks/project.json rksVersion with the ACTUAL
// shell version on BOTH branches — the main branch (skeleton ships a .rks/project.json,
// historically frozen at "0.1.0") and the minimal-config fallback (no skeleton project.json).

const STACK = "test-stack";
const SHELL_VERSION = "9.9.9";
let shellRoot;
let target;

function makeShell({ withSkeletonProjectJson }) {
  shellRoot = mkdtempSync(join(tmpdir(), "rks-shell-"));
  writeFileSync(join(shellRoot, "package.json"), JSON.stringify({ name: "routekit-shell-core", version: SHELL_VERSION }));
  const skel = join(shellRoot, "templates", STACK, "skeleton");
  mkdirSync(skel, { recursive: true });
  writeFileSync(join(shellRoot, "templates", STACK, "kg.yaml"), "nodes: []\n");
  writeFileSync(join(skel, "index.html"), "<html></html>\n");
  if (withSkeletonProjectJson) {
    mkdirSync(join(skel, ".rks"), { recursive: true });
    writeFileSync(
      join(skel, ".rks", "project.json"),
      JSON.stringify({ id: "template-placeholder", rksVersion: "0.1.0", kgFile: "routekit/kg.yaml" }, null, 2),
    );
  }
}

beforeEach(() => {
  // initProjectFromStack requires an existing EMPTY target dir; mkdtemp gives exactly that.
  target = mkdtempSync(join(tmpdir(), "rks-target-"));
});
afterEach(() => {
  for (const d of [shellRoot, target]) {
    if (d) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
  }
});

describe("initProjectFromStack — rksVersion stamping", () => {
  it("main branch: stamps the real shell version over the skeleton's frozen 0.1.0", async () => {
    makeShell({ withSkeletonProjectJson: true });
    await initProjectFromStack({ shellRoot, id: "my-calc", stackId: STACK, targetPath: target });
    const pj = JSON.parse(readFileSync(join(target, ".rks", "project.json"), "utf8"));
    expect(pj.id).toBe("my-calc");
    expect(pj.rksVersion).toBe(SHELL_VERSION);
    expect(pj.rksVersion).not.toBe("0.1.0");
    expect(pj.kgFile).toBe("routekit/kg.yaml");
  });

  it("fallback branch: minimal config gets the real shell version, not 0.1.0", async () => {
    makeShell({ withSkeletonProjectJson: false });
    await initProjectFromStack({ shellRoot, id: "my-calc", stackId: STACK, targetPath: target });
    const pj = JSON.parse(readFileSync(join(target, ".rks", "project.json"), "utf8"));
    expect(pj.id).toBe("my-calc");
    expect(pj.rksVersion).toBe(SHELL_VERSION);
  });
});
