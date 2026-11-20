import { describe, it, expect } from "vitest";
import path from "node:path";
import fs from "node:fs";
import { makeTempDir, writeFile, ensureDir } from "./helpers/tmp.mjs";
import { vendorRoutekitShell } from "../packages/cli/src/vendor/toolchain.mjs";

describe("vendoring toolchain", () => {
  it("copies a toolchain and writes ROUTEKIT_PIN.json", async () => {
    const shellRoot = makeTempDir("toolchain_src");
    writeFile(path.join(shellRoot, "package.json"), JSON.stringify({ name: "routekit-shell", version: "9.9.9" }, null, 2));
    ensureDir(path.join(shellRoot, "packages", "cli"));
    writeFile(path.join(shellRoot, "packages", "cli", "package.json"), "{}\n");
    ensureDir(path.join(shellRoot, "node_modules"));
    writeFile(path.join(shellRoot, "node_modules", "should-not-copy.txt"), "nope\n");

    const projectRoot = makeTempDir("toolchain_dest");
    writeFile(path.join(projectRoot, "package.json"), "{}\n");

    const result = await vendorRoutekitShell({ shellRoot, projectRoot });
    expect(result.ok).toBe(true);
    expect(fs.existsSync(path.join(projectRoot, "tools", "routekit-shell", "package.json"))).toBe(true);
    expect(fs.existsSync(path.join(projectRoot, "tools", "routekit-shell", "ROUTEKIT_PIN.json"))).toBe(true);
    expect(fs.existsSync(path.join(projectRoot, "tools", "routekit-shell", "node_modules"))).toBe(false);
  });

  it("refuses to overwrite without --yes", async () => {
    const shellRoot = makeTempDir("toolchain_src_overwrite");
    writeFile(path.join(shellRoot, "package.json"), JSON.stringify({ name: "routekit-shell", version: "9.9.9" }, null, 2));
    const projectRoot = makeTempDir("toolchain_dest_overwrite");
    ensureDir(path.join(projectRoot, "tools", "routekit-shell"));
    writeFile(path.join(projectRoot, "tools", "routekit-shell", "existing.txt"), "x\n");

    await expect(vendorRoutekitShell({ shellRoot, projectRoot, yes: false })).rejects.toThrow(/already exists/i);
  });
});

