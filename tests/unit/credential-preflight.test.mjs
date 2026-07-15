import { describe, it, expect } from "vitest";
import {
  resolveRequiredCredential,
  checkRequiredCredential,
  resolveSources,
  formatProvenanceLines,
  RECOGNIZED_CREDENTIAL_KEYS,
} from "../../packages/mcp-rks/src/llm/credential-preflight.mjs";
import { inferProvider } from "../../packages/mcp-rks/src/llm/clients.mjs";

// backlog.chore.credential-preflight-and-source-provenance-logging
// Pure-module witness: every function takes an INJECTED env object + explicit shell-snapshot /
// ordered-.env-source arguments. No process.env mutation, no subprocess. rks requires exactly ONE
// provider-appropriate credential (ANTHROPIC or OPENAI), resolved via the shared inferProvider.

describe("credential preflight — required-credential validation (single provider-dependent key)", () => {
  it("PASS (explicit anthropic): validates ONLY ANTHROPIC_API_KEY, never demands OPENAI_API_KEY", () => {
    const env = { ROUTEKIT_LLM_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-a" };
    expect(() => checkRequiredCredential(env)).not.toThrow();
    expect(resolveRequiredCredential(env)).toMatchObject({ provider: "anthropic", requiredKey: "ANTHROPIC_API_KEY", present: true });
  });

  it("PASS (explicit openai): resolves openai, never demands ANTHROPIC_API_KEY", () => {
    const env = { ROUTEKIT_LLM_PROVIDER: "openai", OPENAI_API_KEY: "sk-o" };
    expect(() => checkRequiredCredential(env)).not.toThrow();
    expect(resolveRequiredCredential(env).requiredKey).toBe("OPENAI_API_KEY");
  });

  it("PASS (inferred anthropic): only ANTHROPIC_API_KEY present → passes on that single key", () => {
    const env = { ANTHROPIC_API_KEY: "sk-a" };
    expect(() => checkRequiredCredential(env)).not.toThrow();
    expect(resolveRequiredCredential(env).provider).toBe("anthropic");
  });

  it("PASS (inferred openai): only OPENAI_API_KEY present → passes on that single key", () => {
    const env = { OPENAI_API_KEY: "sk-o" };
    expect(() => checkRequiredCredential(env)).not.toThrow();
    expect(resolveRequiredCredential(env).provider).toBe("openai");
  });

  it("FAIL (missing key for resolved provider): names the missing key AND the resolved provider", () => {
    const env = { ROUTEKIT_LLM_PROVIDER: "anthropic" }; // no ANTHROPIC_API_KEY
    expect(() => checkRequiredCredential(env)).toThrow(/ANTHROPIC_API_KEY/);
    expect(() => checkRequiredCredential(env)).toThrow(/anthropic/);
  });

  it("FAIL (no provider resolvable): neither key + no explicit provider → throws (true fail-fast)", () => {
    const env = {};
    expect(resolveRequiredCredential(env).provider).toBeNull();
    expect(() => checkRequiredCredential(env)).toThrow(/no llm (provider|credential)|could be resolved/i);
  });

  it("VALUE NEVER EXPOSED: no thrown message contains the credential value", () => {
    // Provider resolves anthropic (sentinel present) but we force the fail path by requiring a
    // DIFFERENT provider whose key is absent — the message must never leak any value.
    const env = { ROUTEKIT_LLM_PROVIDER: "openai", ANTHROPIC_API_KEY: "SENTINEL-SECRET-123" };
    let msg = "";
    try { checkRequiredCredential(env); } catch (e) { msg = e.message; }
    expect(msg).toContain("OPENAI_API_KEY");
    expect(msg).not.toContain("SENTINEL-SECRET-123");
  });

  it("uses the SAME shared inferProvider rule as clients.mjs (parity, not a reimplementation)", () => {
    for (const env of [
      { ROUTEKIT_LLM_PROVIDER: "openai", ANTHROPIC_API_KEY: "k" },
      { ANTHROPIC_API_KEY: "k", OPENAI_API_KEY: "k2" },
      {},
    ]) {
      expect(resolveRequiredCredential(env).provider).toBe(inferProvider(env));
    }
  });
});

describe("credential preflight — source provenance", () => {
  const snap = (keys) => Object.fromEntries(keys.map((k) => [k, true]));

  it("SHELL: a key in the pre-dotenv shell snapshot resolves to 'shell environment' (not a path)", () => {
    const sources = resolveSources(snap(["ANTHROPIC_API_KEY"]), []);
    expect(sources).toEqual([{ key: "ANTHROPIC_API_KEY", source: "shell environment" }]);
  });

  it("RUNTIME .env PATH: a key not in shell but in the runtime .env resolves to that path", () => {
    const sources = resolveSources({}, [
      { path: "/proj/.env", parsed: { ANTHROPIC_API_KEY: "x" } },
      { path: "/root/.env", parsed: {} },
    ]);
    expect(sources).toEqual([{ key: "ANTHROPIC_API_KEY", source: "/proj/.env" }]);
  });

  it("MAIN .env PATH: a key only in the main-project .env resolves to that path (files distinguished)", () => {
    const sources = resolveSources({}, [
      { path: "/proj/.env", parsed: {} },
      { path: "/root/.env", parsed: { OPENAI_API_KEY: "x" } },
    ]);
    expect(sources).toEqual([{ key: "OPENAI_API_KEY", source: "/root/.env" }]);
  });

  it("FIRST-WINS: same key in BOTH .env files (not shell) reports the runtime path, not main", () => {
    const sources = resolveSources({}, [
      { path: "/proj/.env", parsed: { ANTHROPIC_API_KEY: "runtime" } },
      { path: "/root/.env", parsed: { ANTHROPIC_API_KEY: "main" } },
    ]);
    expect(sources).toEqual([{ key: "ANTHROPIC_API_KEY", source: "/proj/.env" }]);
  });

  it("SHELL SHADOW MADE EXPLICIT: key in shell AND a .env → attributed to 'shell environment'", () => {
    const sources = resolveSources(snap(["ANTHROPIC_API_KEY"]), [
      { path: "/proj/.env", parsed: { ANTHROPIC_API_KEY: "would-be-shadowed" } },
    ]);
    expect(sources).toEqual([{ key: "ANTHROPIC_API_KEY", source: "shell environment" }]);
  });

  it("LOG FORMAT: each line carries the key NAME + source only, never a value", () => {
    const lines = formatProvenanceLines(resolveSources(snap(["ANTHROPIC_API_KEY"]), []));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("ANTHROPIC_API_KEY");
    expect(lines[0]).toContain("shell environment");
    expect(lines[0]).not.toMatch(/=|sk-/); // no key=value, no value fragment
  });

  it("only recognized credential keys are attributed", () => {
    expect(RECOGNIZED_CREDENTIAL_KEYS).toEqual(expect.arrayContaining(["ANTHROPIC_API_KEY", "OPENAI_API_KEY"]));
    const sources = resolveSources({}, [{ path: "/proj/.env", parsed: { SOME_OTHER_VAR: "x" } }]);
    expect(sources).toEqual([]);
  });
});
