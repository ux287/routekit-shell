// Unit tier: pure reads plus in-process import of scripts/remote-lane.mjs (no subprocess).
// The script runs main() only behind an entry guard, so importing it here has no side effect.
import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(fileURLToPath(import.meta.url), "../../..");
const SCRIPT = path.join(ROOT, "scripts", "remote-lane.mjs");
const GUIDE = path.join(ROOT, "notes", "public.guide.remote-lane.md");

describe("remote-lane owner runbook (unit)", () => {
  it("main --help returns 0 and lists every subcommand", async () => {
    const { main } = await import(SCRIPT);
    const writes = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((s) => { writes.push(String(s)); return true; });
    let code;
    try { code = await main(["--help"]); } finally { spy.mockRestore(); }
    expect(code).toBe(0);
    const text = writes.join("");
    expect(text).toMatch(/usage:/);
    for (const sub of ["setup", "check", "start", "inbox", "alias"]) expect(text).toContain(sub);
  });

  it("package.json remote-lane script entry", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
    expect(pkg.scripts["remote-lane"]).toBe("node scripts/remote-lane.mjs");
  });

  it("reuses the bin exported boot checks", () => {
    const src = fs.readFileSync(SCRIPT, "utf8");
    expect(src).toContain('path.join(REPO_ROOT, "packages", "mcp-rks", "bin", "mcp-rks-http.mjs")');
    for (const fn of ["readRemoteDotenv", "buildBootEnv", "checkBootEnv"]) {
      expect(src).toMatch(new RegExp(`\\bbin\\.${fn}\\(`));
      expect(src).not.toMatch(new RegExp(`function\\s+${fn}\\b`));
      expect(src).not.toMatch(new RegExp(`(?:const|let|var)\\s+${fn}\\s*=`));
    }
  });

  it("buildStartSpec sets root, actor and port and never passes the bearer", async () => {
    const { buildStartSpec, HTTP_BIN } = await import(SCRIPT);
    const spec = buildStartSpec({ root: "rel/wt", actor: "grok", port: 4567, env: { RKS_REMOTE_BEARER: "x".repeat(40), PATH: "/bin" } });
    expect(spec.command).toBe(process.execPath);
    expect(spec.args).toEqual([HTTP_BIN]);
    expect(HTTP_BIN).toBe(path.join(ROOT, "packages", "mcp-rks", "bin", "mcp-rks-http.mjs"));
    expect(spec.env.RKS_REMOTE_ROOT).toBe(path.resolve("rel/wt"));
    expect(spec.env.RKS_ACTOR).toBe("grok");
    expect(spec.env.RKS_REMOTE_PORT).toBe("4567");
    expect(spec.env.PATH).toBe("/bin");
    expect("RKS_REMOTE_BEARER" in spec.env).toBe(false);
  });

  it("guide has an Owner operations section between the tunnel paragraph and Refusals", () => {
    const md = fs.readFileSync(GUIDE, "utf8");
    const tunnel = md.indexOf("The server binds loopback only.");
    const owner = md.indexOf("## Owner operations");
    const refusals = md.indexOf("## Refusals a client will see");
    expect(tunnel).toBeGreaterThanOrEqual(0);
    expect(owner).toBeGreaterThan(tunnel);
    expect(refusals).toBeGreaterThan(owner);
    const section = md.slice(owner, refusals);
    expect(section).toContain("scripts/remote-lane.mjs");
    for (const word of ["setup", "check", "start", "inbox", "tunnel", "index"]) expect(section.toLowerCase()).toContain(word);
    expect(section).toMatch(/Ctrl-C|SIGTERM/);
  });
});
