/**
 * Witness for backlog.feat.onboarder-subscription-credential-fork.
 *
 * Static and in-process: every credential path uses an injected resolver, so there is no spawn,
 * no network, no real claude binary and no @routekit/telemetry import. Every runOnboarder call
 * uses a fresh mkdtemp project root (never the repo ROOT); server/telemetry.mjs is mocked as in
 * onboarder.phase2-5. Repo .env / .rks/agents.yaml are compared by digest only, never logged.
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { STAGES, runOnboarder } from "../../packages/mcp-rks/src/server/onboarder.mjs";
import { MIN_CLAUDE_VERSION } from "../../packages/mcp-rks/src/llm/claude-cli/probe.mjs";
import { FLOWS, FLOW_AGENTS, subscriptionFixHint, recordBootDotenvCopied, resetBootDotenvCopied } from "../../packages/mcp-rks/src/llm/claude-cli/subscription-status.mjs";
import { resolveAgentBackend } from "../../packages/mcp-rks/src/agents/config.mjs";

vi.mock("../../packages/mcp-rks/src/server/telemetry.mjs", () => ({ recordTelemetry: vi.fn() }));

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const skill = () => read(".claude/skills/rks-onboard/SKILL.md");
const onboarderSection = () => {
  const md = read("CLAUDE.md");
  const heading = "## Onboarder Auto-Trigger";
  const start = md.indexOf(heading);
  expect(start).toBeGreaterThan(-1);
  const rest = md.slice(start + heading.length);
  const next = rest.indexOf("\n## ");
  return next === -1 ? rest : rest.slice(0, next);
};

const digest = (abs) => (fs.existsSync(abs) ? crypto.createHash("sha256").update(fs.readFileSync(abs)).digest("hex") : null);
const ROOT_ENV = path.join(ROOT, ".env");
const ROOT_AGENTS = path.join(ROOT, ".rks", "agents.yaml");
let rootDigests;
beforeAll(() => {
  rootDigests = { env: digest(ROOT_ENV), envExists: fs.existsSync(ROOT_ENV), agents: digest(ROOT_AGENTS) };
});
afterAll(() => {
  // Digests only — the file contents are never logged.
  expect(fs.existsSync(ROOT_ENV)).toBe(rootDigests.envExists);
  expect(digest(ROOT_ENV) === rootDigests.env).toBe(true);
  expect(digest(ROOT_AGENTS) === rootDigests.agents).toBe(true);
});

const BUILD_AGENTS = [...FLOW_AGENTS["build-onrail"]];
const allAdmitted = () => Object.fromEntries(FLOWS.map((f) => [f, "admitted"]));
const allBlocked = (blocked = "no_credential") => Object.fromEntries(FLOWS.map((f) => [f, { blocked }]));
const subscriptionResolver = (over = {}) =>
  vi.fn(async () => ({
    credential: "subscription",
    capabilities: allAdmitted(),
    subscription: { ready: true, reason: null, researchBackend: "claude-cli" },
    ...over,
  }));
const noneResolver = () => vi.fn(async () => ({ credential: "none", capabilities: allBlocked() }));

// RKS_*_BACKEND overrides would shadow agents.yaml in resolveAgentBackend: clear for each test, restore after.
const savedBackendEnv = {};
let tmp;
beforeEach(() => {
  for (const k of Object.keys(process.env)) {
    if (/^RKS_.*_BACKEND$/.test(k)) { savedBackendEnv[k] = process.env[k]; delete process.env[k]; }
  }
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "onboarder-credential-"));
  fs.writeFileSync(path.join(tmp, ".gitignore"), ".env\n");
});
afterEach(() => {
  for (const [k, v] of Object.entries(savedBackendEnv)) { process.env[k] = v; delete savedBackendEnv[k]; }
  fs.rmSync(tmp, { recursive: true, force: true });
});

const run = (responses, resolver, env = {}, extra = {}) =>
  runOnboarder({ projectId: "fixture", projectRoot: tmp, responses, credentialResolver: resolver, env, ...extra });

const envPath = () => path.join(tmp, ".env");
const yamlPath = () => path.join(tmp, ".rks", "agents.yaml");
const listedFlows = (display) => [...display.matchAll(/^\s*- `([\w-]+)` — (admitted|blocked by (.+))$/gm)].map((m) => ({ flow: m[1], admitted: m[2] === "admitted", blocker: m[3] || null }));

async function seedStory(resolver) {
  await run({ governorResult: { ok: true, storyId: "backlog.feat.fixture-story" } }, resolver, {}, { stage: "first_story" });
}

describe("onboarder credential step — no stage, no behavior change without a choice", () => {
  it("adds no stage", () => {
    expect(STAGES).toEqual(["welcome", "expectations", "stance", "first_story", "first_build", "first_ship", "next_steps"]);
  });

  it("never resolves the credential when no choice was given and none is recorded; tour dispatch is unchanged", async () => {
    const resolver = subscriptionResolver();
    for (const stage of ["welcome", "expectations", "stance"]) await run({}, resolver, {}, { stage });
    const story = await run({ userInput: "demo" }, resolver, {}, { stage: "first_story" });
    expect(story.pendingDispatch).toMatchObject({ type: "po", isDemo: true });
    await seedStory(resolver);
    const build = await run({}, resolver, {}, { stage: "first_build" });
    expect(build.pendingDispatch).toEqual({ type: "build", storyId: "backlog.feat.fixture-story" });
    expect(resolver).toHaveBeenCalledTimes(0);

    // positive control: the same kind of spy IS called on the credential path
    const spy = subscriptionResolver();
    await run({ credentialChoice: "subscription" }, spy);
    expect(spy.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it("the credential step does not advance completedStages", async () => {
    const r = await run({ credentialChoice: "neither" }, noneResolver());
    expect(r.state.completedStages).toEqual([]);
    expect(r.step).toBe("credential");
  });

  it("the welcome display names the fork and how to answer it", async () => {
    const r = await run({}, noneResolver(), {}, { stage: "welcome" });
    expect(r.display).toMatch(/API key/);
    expect(r.display).toMatch(/Claude subscription/);
    expect(r.display).toMatch(/neither/);
    expect(r.display).toMatch(/\*\*api\*\*, \*\*subscription\*\* or \*\*neither\*\*/);
    expect(r.display).toContain("credential step");
    expect(r.display).toContain("Ready to continue?");
  });
});

describe("onboarder credential step — subscription without consent", () => {
  it("writes nothing, shows the exact lines and asks for consent", async () => {
    const resolver = noneResolver();
    const r = await run({ credentialChoice: "subscription" }, resolver);
    expect(fs.existsSync(envPath())).toBe(false);
    expect(fs.existsSync(yamlPath())).toBe(false);
    expect(r.writes).toEqual([]);
    expect(r.display).toContain("RKS_SUBSCRIPTION_CREDENTIAL=1");
    expect(r.display).toContain("agents:");
    for (const a of BUILD_AGENTS) expect(r.display).toContain(`${a}:`);
    expect(r.display).toContain("backend: claude-cli");
    expect(r.display).toMatch(/Do you agree to these writes\?/);
    expect(r.proposed.env).toBe("RKS_SUBSCRIPTION_CREDENTIAL=1");
  });
});

describe("onboarder credential step — consented writes", () => {
  it("writes land, read back, and precede the final resolver call", async () => {
    const order = [];
    const resolver = vi.fn(async ({ projectRoot }) => {
      order.push({ projectRoot, env: fs.existsSync(envPath()), yaml: fs.existsSync(yamlPath()) });
      return { credential: "subscription", capabilities: allAdmitted(), subscription: { ready: true, reason: null, researchBackend: "claude-cli" } };
    });
    const r = await run({ credentialChoice: "subscription", credentialConsent: "yes" }, resolver);
    expect(fs.readFileSync(envPath(), "utf8").split("\n")).toContain("RKS_SUBSCRIPTION_CREDENTIAL=1");
    expect(fs.existsSync(yamlPath())).toBe(true);
    for (const a of BUILD_AGENTS) expect(resolveAgentBackend(a, tmp)).toBe("claude-cli");
    const byFile = Object.fromEntries(r.writes.map((w) => [w.file, w]));
    expect(byFile[".env"].written).toBe(true);
    expect(byFile[".rks/agents.yaml"].written).toBe(true);
    const last = order[order.length - 1];
    expect(last).toEqual({ projectRoot: tmp, env: true, yaml: true });
    for (const c of order) expect(c.projectRoot).toBe(tmp);
  });

  it("reports a write that cannot happen as written false with a reason", async () => {
    fs.writeFileSync(path.join(tmp, ".rks"), "not a directory");
    const r = await run({ credentialChoice: "subscription", credentialConsent: "yes" }, noneResolver());
    const yaml = r.writes.find((w) => w.file === ".rks/agents.yaml");
    expect(yaml.written).toBe(false);
    expect(yaml.reason).toBeTruthy();
    expect(r.display).toMatch(/`\.rks\/agents\.yaml`: \*\*not written\*\*/);
  });

  it("preserves an existing .env, appends once, and never echoes other values", async () => {
    const prior = "SOME_TOKEN=sentinel-value\nOTHER=1";
    fs.writeFileSync(envPath(), prior);
    const r1 = await run({ credentialChoice: "subscription", credentialConsent: "yes" }, noneResolver());
    const after1 = fs.readFileSync(envPath(), "utf8");
    expect(after1.startsWith(prior)).toBe(true);
    expect(after1.match(/^RKS_SUBSCRIPTION_CREDENTIAL=1$/gm)).toHaveLength(1);
    const r2 = await run({ credentialChoice: "subscription", credentialConsent: "yes" }, noneResolver());
    expect(fs.readFileSync(envPath(), "utf8")).toBe(after1);
    for (const r of [r1, r2]) {
      expect(r.display).not.toContain("sentinel-value");
      expect(JSON.stringify(r)).not.toContain("sentinel-value");
    }
  });

  it("refuses the .env write when .gitignore has no .env line", async () => {
    fs.writeFileSync(path.join(tmp, ".gitignore"), "node_modules\n");
    const r = await run({ credentialChoice: "subscription", credentialConsent: "yes" }, noneResolver());
    const env = r.writes.find((w) => w.file === ".env");
    expect(env).toMatchObject({ written: false, reason: "env_not_gitignored" });
    expect(fs.existsSync(envPath())).toBe(false);
    expect(r.display).toMatch(/```\n\s*\.env\n\s*```/);
  });

  it("skips .env when the env already defines the opt-in; a shell-set non-1 value needs an MCP restart", async () => {
    const r = await run({ credentialChoice: "subscription", credentialConsent: "yes" }, noneResolver(), { RKS_SUBSCRIPTION_CREDENTIAL: "0" });
    expect(fs.existsSync(envPath())).toBe(false);
    expect(r.writes.find((w) => w.file === ".env").written).toBe(false);
    expect(r.display).toMatch(/set in the shell environment before MCP boot/);
    expect(r.display).not.toMatch(/That value was set at MCP boot/);
    expect(r.display).toMatch(/MCP restart/);
    const on = await run({ credentialChoice: "subscription", credentialConsent: "yes" }, subscriptionResolver(), { RKS_SUBSCRIPTION_CREDENTIAL: "1" });
    expect(fs.existsSync(envPath())).toBe(false);
    expect(on.writes.find((w) => w.file === ".env").written).toBe(false);
  });

  it("never modifies an existing agents.yaml and gives the lines to add", async () => {
    fs.mkdirSync(path.join(tmp, ".rks"), { recursive: true });
    const existing = "agents:\n  research:\n    model: claude-haiku-4-5\n";
    fs.writeFileSync(yamlPath(), existing);
    const before = digest(yamlPath());
    const r = await run({ credentialChoice: "subscription", credentialConsent: "yes" }, noneResolver());
    expect(digest(yamlPath())).toBe(before);
    const yaml = r.writes.find((w) => w.file === ".rks/agents.yaml");
    expect(yaml.written).toBe(false);
    expect(r.display).toContain("backend: claude-cli");
    expect(r.display).toContain("research:");
  });

  it("states the opt-in timing rule after a successful .env write", async () => {
    const r = await run({ credentialChoice: "subscription", credentialConsent: "yes" }, noneResolver());
    expect(r.writes.find((w) => w.file === ".env").written).toBe(true);
    expect(r.display).toMatch(/MCP restart/);
    expect(r.display).toMatch(/next Governor start/);
    expect(r.display).toMatch(/read fresh at each Governor start/);
    expect(r.display).toMatch(/with no MCP restart/);
    expect(r.display).toMatch(/set in the shell environment before MCP boot/);
    expect(r.display).not.toMatch(/A value that was present at MCP boot needs an MCP restart/);
  });

  describe("a boot-dotenv-copied server-env value is not server-env-defined (backlog.fix.subscription-opt-in-read-consistency)", () => {
    afterEach(() => { resetBootDotenvCopied(); vi.unstubAllEnvs(); });

    it("a non-1 value copied from the project .env: the .env decides, and no restart is claimed", async () => {
      fs.writeFileSync(envPath(), "RKS_SUBSCRIPTION_CREDENTIAL=0\n");
      vi.stubEnv("RKS_SUBSCRIPTION_CREDENTIAL", "0");
      recordBootDotenvCopied({ RKS_SUBSCRIPTION_CREDENTIAL: "0" });
      const r = await run({ credentialChoice: "subscription", credentialConsent: "yes" }, noneResolver(), process.env);
      const w = r.writes.find((x) => x.file === ".env");
      expect(w.written).toBe(false);
      expect(w.reason).toBe("env_has_other_value");
      expect(r.display).not.toMatch(/already defined in the MCP server environment/);
      expect(r.display).not.toMatch(/set in the shell environment before MCP boot, so it is fixed/);
    });

    it("a 1 copied from the rks repo-root .env (project .env absent): the opt-in is appended to the project .env", async () => {
      vi.stubEnv("RKS_SUBSCRIPTION_CREDENTIAL", "1");
      recordBootDotenvCopied({ RKS_SUBSCRIPTION_CREDENTIAL: "1" });
      const r = await run({ credentialChoice: "subscription", credentialConsent: "yes" }, noneResolver(), process.env);
      const w = r.writes.find((x) => x.file === ".env");
      expect(w).toMatchObject({ written: true, action: "appended" });
    });

    it("positive control: the same process.env value NOT recorded as copied is server-env-defined", async () => {
      vi.stubEnv("RKS_SUBSCRIPTION_CREDENTIAL", "0");
      const r = await run({ credentialChoice: "subscription", credentialConsent: "yes" }, noneResolver(), process.env);
      expect(r.writes.find((x) => x.file === ".env")).toMatchObject({ written: false, reason: "env_defined_at_boot" });
      expect(fs.existsSync(envPath())).toBe(false);
    });
  });
});

describe("onboarder credential step — subscription report", () => {
  it("reports ready/reason, the fix hint, the minimum version and the claude commands", async () => {
    const resolver = subscriptionResolver({ subscription: { ready: false, reason: "version_too_old", researchBackend: "claude-cli" } });
    const r = await run({ credentialChoice: "subscription" }, resolver, { RKS_SUBSCRIPTION_CREDENTIAL: "1" });
    expect(r.display).toContain("ready: `false`");
    expect(r.display).toContain("version_too_old");
    expect(r.display).toContain(subscriptionFixHint({ probeReason: "version_too_old" }));
    expect(r.display).toContain(MIN_CLAUDE_VERSION);
    expect(r.display).toContain("claude auth status");
    expect(r.display).toContain("claude /login");
  });

  it("lists admitted and blocked flows from FLOWS, with blockers, and says the map is report-only", async () => {
    const caps = { ...allAdmitted(), "build-onrail": { blocked: "llm-planner" }, "external-research": { blocked: "external-research" } };
    const r = await run({ credentialChoice: "subscription" }, subscriptionResolver({ capabilities: caps }), { RKS_SUBSCRIPTION_CREDENTIAL: "1" });
    const listed = listedFlows(r.display);
    expect(listed.length).toBe(FLOWS.length);
    for (const l of listed) expect(FLOWS).toContain(l.flow);
    expect(listed.find((l) => l.flow === "build-onrail")).toMatchObject({ admitted: false, blocker: "llm-planner" });
    expect(listed.find((l) => l.flow === "research").admitted).toBe(true);
    expect(r.display).toMatch(/report-only/);
  });

  it("carries the ROUTEKIT_LLM_MODEL caveat only when it is unset, and never says on-rail Build needs an API key", async () => {
    const unset = await run({ credentialChoice: "subscription" }, subscriptionResolver(), { RKS_SUBSCRIPTION_CREDENTIAL: "1" });
    expect(unset.caveat).toMatch(/ROUTEKIT_LLM_MODEL/);
    expect(unset.display).toContain("ROUTEKIT_LLM_MODEL");
    expect(unset.display).toMatch(/capabilities map does not check it/);
    const set = await run({ credentialChoice: "subscription" }, subscriptionResolver(), { RKS_SUBSCRIPTION_CREDENTIAL: "1", ROUTEKIT_LLM_MODEL: "claude-sonnet-5-5" });
    expect(set.caveat).toBeUndefined();
    for (const r of [unset, set]) {
      expect(r.display).not.toMatch(/on-rail Build[^.\n]*needs an API key/i);
      expect(r.display).not.toContain("oneshot-callers-keyless-reachable");
    }
  });
});

describe("onboarder credential step — dispatch gating", () => {
  it("with a recorded credential, first_story dispatches only when po is admitted", async () => {
    await run({ credentialChoice: "subscription" }, subscriptionResolver(), { RKS_SUBSCRIPTION_CREDENTIAL: "1" });
    const blocked = await run({ userInput: "demo" }, vi.fn(async () => ({ credential: "subscription", capabilities: { ...allAdmitted(), po: { blocked: "research" } } })), {}, { stage: "first_story" });
    expect(blocked.pendingDispatch).toBeUndefined();
    expect(blocked.display).toContain("research");
    const ok = await run({ userInput: "demo" }, subscriptionResolver(), {}, { stage: "first_story" });
    expect(ok.pendingDispatch).toMatchObject({ type: "po" });
  });

  it("with a recorded credential, first_build dispatches only when build-onrail is admitted", async () => {
    await seedStory(noneResolver());
    await run({ credentialChoice: "subscription" }, subscriptionResolver(), { RKS_SUBSCRIPTION_CREDENTIAL: "1" });
    const gate = vi.fn(async () => ({ credential: "subscription", capabilities: { ...allAdmitted(), "build-onrail": { blocked: "llm-planner" } } }));
    const blocked = await run({}, gate, {}, { stage: "first_build" });
    expect(gate).toHaveBeenCalled();
    expect(blocked.pendingDispatch).toBeUndefined();
    expect(blocked.display).toContain("llm-planner");
    const ok = await run({}, subscriptionResolver(), {}, { stage: "first_build" });
    expect(ok.pendingDispatch).toEqual({ type: "build", storyId: "backlog.feat.fixture-story" });
  });
});

describe("onboarder credential step — neither, api, and resolver failure", () => {
  it("neither with credential none writes nothing and names the keyless demo path", async () => {
    const r = await run({ credentialChoice: "neither", credentialConsent: "yes" }, noneResolver());
    expect(fs.existsSync(envPath())).toBe(false);
    expect(fs.existsSync(yamlPath())).toBe(false);
    expect(r.display).toContain("rks_rag_query");
    expect(r.display).toContain("keyless-notes");
  });

  it("api with credential api writes nothing and lists every flow admitted", async () => {
    const api = () => vi.fn(async () => ({ credential: "api", capabilities: allAdmitted() }));
    const r = await run({ credentialChoice: "api" }, api());
    expect(fs.existsSync(envPath())).toBe(false);
    expect(fs.existsSync(yamlPath())).toBe(false);
    const listed = listedFlows(r.display);
    expect(listed.length).toBe(FLOWS.length);
    expect(listed.every((l) => l.admitted)).toBe(true);
    // an api result wins over the choice given — even a consented subscription answer
    const won = await run({ credentialChoice: "subscription", credentialConsent: "yes" }, api());
    expect(won.credential.credential).toBe("api");
    expect(won.writes).toEqual([]);
    expect(fs.existsSync(envPath())).toBe(false);
    expect(fs.existsSync(yamlPath())).toBe(false);
  });

  it("a throwing resolver yields an error entry, no admitted flow and no dispatch", async () => {
    const boom = vi.fn(async () => { throw new Error("probe exploded"); });
    const r = await run({ credentialChoice: "subscription" }, boom);
    expect(r.credential.error).toContain("probe exploded");
    expect(r.display).toMatch(/could not be determined/);
    expect(listedFlows(r.display).some((l) => l.admitted)).toBe(false);
    expect(r.pendingDispatch).toBeUndefined();
    const story = await run({ userInput: "demo" }, boom, {}, { stage: "first_story" });
    expect(story.pendingDispatch).toBeUndefined();
    expect(story.display).toMatch(/could not be determined/);
  });

  const noWrites = (r) => {
    expect(r.writes).toEqual([]);
    expect(fs.existsSync(envPath())).toBe(false);
    expect(fs.existsSync(yamlPath())).toBe(false);
  };
  const detectedLine = (display) => display.split("\n").find((l) => /subscription credential was detected/.test(l));
  const namedFlows = (line) => [...line.matchAll(/`([\w-]+)`/g)].map((m) => m[1]);

  it("neither with credential subscription names the keyless path and exactly the admitted flows", async () => {
    const caps = { ...allAdmitted(), "build-onrail": { blocked: "llm-planner" }, "external-research": { blocked: "external-research" } };
    const r = await run({ credentialChoice: "neither" }, subscriptionResolver({ capabilities: caps }), { RKS_SUBSCRIPTION_CREDENTIAL: "1" });
    expect(r.display).toContain("rks_rag_query");
    expect(r.display).toContain("keyless-notes");
    const line = detectedLine(r.display);
    expect(line).toBeTruthy();
    const expected = Object.entries(caps).filter(([, v]) => v === "admitted").map(([f]) => f);
    expect(namedFlows(line).sort()).toEqual([...expected].sort());
    expect(namedFlows(line)).not.toContain("build-onrail");
    expect(namedFlows(line)).not.toContain("external-research");
    noWrites(r);
  });

  it("neither with credential api keeps the API-key-wins sentence and names the keyless path", async () => {
    const r = await run({ credentialChoice: "neither" }, vi.fn(async () => ({ credential: "api", capabilities: allAdmitted() })));
    expect(r.display).toContain("An API key wins over the **neither** answer");
    expect(r.display).toContain("rks_rag_query");
    expect(r.display).toContain("keyless-notes");
    expect(detectedLine(r.display)).toBeUndefined();
    noWrites(r);
  });

  it("api with credential none says no key is visible to the MCP server and writes nothing", async () => {
    const r = await run({ credentialChoice: "api" }, noneResolver());
    expect(r.display).toMatch(/No API key[^.\n]*is visible to the MCP server/);
    noWrites(r);
  });

  it("api with credential none blocks first_story and first_build with a key-specific fix", async () => {
    await seedStory(noneResolver());
    await run({ credentialChoice: "api" }, noneResolver());
    const generic = (header, governor, flow) => `${header}\n\nNot dispatching the ${governor}: the \`${flow}\` flow is blocked by \`no_credential\` on this machine's credential.`;

    const story = await run({ userInput: "demo" }, noneResolver(), {}, { stage: "first_story" });
    const build = await run({}, noneResolver(), {}, { stage: "first_build" });
    for (const [r, start] of [
      [story, generic("Stage 4 of 7 — Your First Story.", "Product Owner Governor", "po")],
      [build, generic("Stage 5 of 7 — First Build.", "Build Governor", "build-onrail")],
    ]) {
      expect(r.pendingDispatch).toBeUndefined();
      expect(r.display).toMatch(/ANTHROPIC_API_KEY|OPENAI_API_KEY/);
      expect(r.display).toMatch(/restart the MCP server/);
      expect(r.display.startsWith(start)).toBe(false);
      expect(r.display).not.toContain("on this machine's credential. Running it now");
    }
    expect(story.dispatchBlocked).toMatchObject({ flow: "po" });
    expect(build.dispatchBlocked).toMatchObject({ flow: "build-onrail" });

    // positive control: a fresh api credential lets the same recorded answer dispatch
    const api = () => vi.fn(async () => ({ credential: "api", capabilities: allAdmitted() }));
    expect((await run({ userInput: "demo" }, api(), {}, { stage: "first_story" })).pendingDispatch).toMatchObject({ type: "po" });
    expect((await run({}, api(), {}, { stage: "first_build" })).pendingDispatch).toEqual({ type: "build", storyId: "backlog.feat.fixture-story" });
  });

  for (const choice of ["subscription", "neither"]) {
    it(`${choice} with credential none still blocks dispatch with the generic display`, async () => {
      await seedStory(noneResolver());
      await run({ credentialChoice: choice }, noneResolver());
      const story = await run({ userInput: "demo" }, noneResolver(), {}, { stage: "first_story" });
      const build = await run({}, noneResolver(), {}, { stage: "first_build" });
      for (const r of [story, build]) {
        expect(r.pendingDispatch).toBeUndefined();
        expect(r.display).toContain("on this machine's credential. Running it now");
        expect(r.display).not.toMatch(/you answered \*\*api\*\*/);
      }
    });
  }
});

describe("rks-onboard SKILL.md relays the credential step", () => {
  it("names credentialChoice, credentialConsent and the three answers", () => {
    const s = skill();
    expect(s).toContain("credentialChoice");
    expect(s).toContain("credentialConsent");
    for (const v of ["`api`", "`subscription`", "`neither`"]) expect(s).toContain(v);
    expect(s).toMatch(/only after the user explicitly agrees/);
  });

  it("never writes .env or .rks/agents.yaml itself, and every .rks/project.json line says never/not", () => {
    const s = skill();
    expect(s).toMatch(/never writes `\.env` or `\.rks\/agents\.yaml` itself/);
    const lines = s.split("\n").filter((l) => l.includes(".rks/project.json"));
    for (const l of lines) expect(l).toMatch(/\bnever\b|\bnot\b/i);
  });
});

describe("CLAUDE.md Onboarder Auto-Trigger names the fork", () => {
  it("mentions all three credential options, routes to /rks-onboard and stays free of issue/github", () => {
    const s = onboarderSection();
    expect(s).toMatch(/API key/i);
    expect(s).toMatch(/subscription/i);
    expect(s).toMatch(/neither/i);
    expect(s).toMatch(/credential[^\n]*`\/rks-onboard`|`\/rks-onboard`[^\n]*credential/i);
    expect(s).not.toMatch(/issue|github/i);
  });
});
