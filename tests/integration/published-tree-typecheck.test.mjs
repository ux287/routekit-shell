/**
 * backlog.fix.publish-set-dangling-imports — AC-5.
 *
 * EMPIRICAL published-tree build. Builds the REAL archive publish.mjs builds
 * (git archive --format=tar HEAD <generateIncludeArgs output>), extracts it, and
 * runs the dashboard's own tsc --noEmit against the extracted package.
 *
 * INTEGRATION TIER — spawns git and tsc. Every spawnSync passes an explicit
 * timeout; pool: "forks" means an untimed hang wedges a fork slot permanently.
 *
 * THIS TEST VALIDATES HEAD, NOT THE WORKING TREE. `git archive HEAD` reads the
 * committed tree, exactly as publish.mjs does. So an uncommitted fix to a shipped
 * module will still show here as a failure until it is committed — that is correct
 * behaviour, not a defect, and it is what makes the test a faithful proxy for what
 * a mirror clone actually receives.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "js-yaml";
import { fileURLToPath } from "node:url";
import { generateIncludeArgs } from "../../packages/mcp-rks/src/server/publish.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PKG = "packages/telemetry-dashboard";
let tmp;

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rks-published-tree-"));
});
afterAll(() => {
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

describe("the published tree compiles (AC-5)", () => {
  it("tsc --noEmit passes on the extracted telemetry-dashboard", () => {
    const profile = yaml.load(
      fs.readFileSync(path.join(REPO_ROOT, ".routekit/publish-profiles.yaml"), "utf8")
    ).profiles["rks-public"];
    const includeArgs = generateIncludeArgs(profile, REPO_ROOT);

    const tar = path.join(tmp, "pub.tar");
    const ar = spawnSync(
      "git",
      ["archive", "--format=tar", "-o", tar, "HEAD", ...includeArgs],
      { cwd: REPO_ROOT, timeout: 60_000, encoding: "utf8" }
    );
    // Surface stderr verbatim: a glob-free include matching nothing hard-fails here
    // with `fatal: pathspec ... did not match any files`. That is profile/tree drift,
    // NOT a dangling import — do not let it masquerade as one.
    expect(ar.status, `git archive failed:\n${ar.stderr ?? ""}`).toBe(0);

    const out = path.join(tmp, "tree");
    fs.mkdirSync(out, { recursive: true });
    const un = spawnSync("tar", ["-xf", tar, "-C", out], { timeout: 60_000, encoding: "utf8" });
    expect(un.status, `tar extract failed:\n${un.stderr ?? ""}`).toBe(0);

    const extracted = path.join(out, PKG);
    expect(fs.existsSync(path.join(extracted, "src/App.tsx"))).toBe(true);
    // POSITIVE CONTROL: the excluded tree really is absent, so the typecheck below
    // is exercising the PUBLISHED shape and not an accidental full copy.
    expect(fs.existsSync(path.join(extracted, "src/presentations"))).toBe(false);

    // node_modules from the working tree — the archive ships no dependencies.
    // This repo HOISTS: packages/telemetry-dashboard/node_modules is empty and
    // @types/react lives at the root. tsc resolves by walking up from the source
    // file, so the link belongs at the extracted tree's ROOT, which reproduces the
    // layout a real `npm install` on a mirror clone would produce.
    fs.symlinkSync(
      path.join(REPO_ROOT, "node_modules"),
      path.join(out, "node_modules"),
      "dir"
    );

    // Invoke the REAL compiler by path. `npx tsc` from the extracted tree resolves
    // to the unrelated deprecated `tsc@2.0.4` npm shim and silently fetches it,
    // which fails for a reason that has nothing to do with the published tree.
    const TSC = path.join(REPO_ROOT, "node_modules/typescript/bin/tsc");
    expect(fs.existsSync(TSC), "typescript is not installed at the repo root").toBe(true);
    const tsc = spawnSync(
      process.execPath,
      [TSC, "--noEmit", "-p", "tsconfig.json"],
      { cwd: extracted, timeout: 180_000, encoding: "utf8" }
    );
    expect(
      tsc.status,
      `published tree does not typecheck:\n${tsc.stdout ?? ""}\n${tsc.stderr ?? ""}`
    ).toBe(0);
  }, 300_000);
});
