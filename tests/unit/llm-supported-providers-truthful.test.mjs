// backlog.chore.llm-supported-providers-truthful
// Deterministic: injected env objects, a per-test mkdtemp dir, and full-source file reads.
// No process.env mutation, no subprocess, no network.
import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  resolveRequiredCredential,
  checkRequiredCredential,
} from "../../packages/mcp-rks/src/llm/credential-preflight.mjs";
import { ensureProjectMetadata } from "../../packages/cli/src/project/metadata.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (rel) => fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");

const tmpDirs = [];
function makeTmpProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rks-supported-providers-"));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop(), { recursive: true, force: true });
});

describe("supportedProviders declarations are truthful", () => {
  it(".rks/project.json llm.supportedProviders is exactly [openai, anthropic]", () => {
    const project = JSON.parse(read(".rks/project.json"));
    expect(project.llm.supportedProviders).toEqual(["openai", "anthropic"]);
  });

  it("ensureProjectMetadata with no base/defaults value writes [openai, anthropic]", () => {
    const root = makeTmpProject();
    const meta = ensureProjectMetadata(root, {});
    expect(meta.llm.supportedProviders).toEqual(["openai", "anthropic"]);
    const onDisk = JSON.parse(fs.readFileSync(path.join(root, "routekit", "project.json"), "utf8"));
    expect(onDisk.llm.supportedProviders).toEqual(["openai", "anthropic"]);
  });

  it("ensureProjectMetadata still honours an explicit defaults.llm.supportedProviders", () => {
    const root = makeTmpProject();
    const meta = ensureProjectMetadata(root, { llm: { supportedProviders: ["anthropic"] } });
    expect(meta.llm.supportedProviders).toEqual(["anthropic"]);
  });
});

describe("checkRequiredCredential rejects an explicit provider with no key mapping", () => {
  it("throws for ROUTEKIT_LLM_PROVIDER=google, naming google and the supported providers", () => {
    let msg = "";
    try { checkRequiredCredential({ ROUTEKIT_LLM_PROVIDER: "google" }); } catch (e) { msg = e.message; }
    expect(msg).toMatch(/google/);
    expect(msg).toMatch(/anthropic/);
    expect(msg).toMatch(/openai/);
  });

  it("the unsupported-provider message carries no credential value", () => {
    let msg = "";
    try {
      checkRequiredCredential({
        ROUTEKIT_LLM_PROVIDER: "google",
        ANTHROPIC_API_KEY: "SENTINEL-A-123",
        OPENAI_API_KEY: "SENTINEL-O-456",
      });
    } catch (e) { msg = e.message; }
    expect(msg).toMatch(/google/);
    expect(msg).not.toContain("SENTINEL-A-123");
    expect(msg).not.toContain("SENTINEL-O-456");
  });

  it("does not throw for anthropic or openai with their key present", () => {
    expect(checkRequiredCredential({ ROUTEKIT_LLM_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "k" }))
      .toEqual({ provider: "anthropic", requiredKey: "ANTHROPIC_API_KEY" });
    expect(checkRequiredCredential({ ROUTEKIT_LLM_PROVIDER: "openai", OPENAI_API_KEY: "k" }))
      .toEqual({ provider: "openai", requiredKey: "OPENAI_API_KEY" });
  });

  it("existing messages are unchanged: no provider, and known provider missing its key", () => {
    expect(() => checkRequiredCredential({})).toThrow(/No LLM provider\/credential could be resolved/);
    expect(() => checkRequiredCredential({ ROUTEKIT_LLM_PROVIDER: "openai" }))
      .toThrow(/Missing required credential OPENAI_API_KEY/);
  });

  it("resolveRequiredCredential keeps its { provider, requiredKey, present } shape for google", () => {
    expect(resolveRequiredCredential({ ROUTEKIT_LLM_PROVIDER: "google" }))
      .toEqual({ provider: "google", requiredKey: null, present: false });
  });

  it("boot keeps the non-fatal catch that prints the preflight error as a WARNING line", () => {
    const bin = read("packages/mcp-rks/bin/mcp-rks.mjs");
    expect(bin).toContain("checkRequiredCredential(process.env);");
    expect(bin).toContain("[preflight] WARNING: ${err.message}");
  });
});

describe("stale backlog state is closed", () => {
  it("backlog.fix.llm-provider-inference is marked implemented (status implemented, phase integrated or released)", () => {
    const note = read("notes/backlog.fix.llm-provider-inference.md");
    expect(note).toMatch(/^status: implemented$/m);
    // Release-safe: rks_release advances integrated -> released and writes the value quoted.
    // [ \t]* (not \s*) so the match cannot run across a line break.
    const POST_SHIP_PHASE = /^phase:[ \t]*["']?(integrated|released)["']?[ \t]*$/m;
    expect(note).toMatch(POST_SHIP_PHASE);
    // Widened to post-ship phases only, not removed.
    expect("phase: integrated").toMatch(POST_SHIP_PHASE);
    expect('phase: "released"').toMatch(POST_SHIP_PHASE);
    expect("phase: executed").not.toMatch(POST_SHIP_PHASE);
    expect("phase: arch-approved").not.toMatch(POST_SHIP_PHASE);
  });
});
