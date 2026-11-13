// backlog.fix.test-suite-mutates-live-project-registry — run-level guard and migration checks.
// The setup/teardown transition cases drive the guard through a stubbed view of the live registry
// (existsSync / readFileSync intercepted for LIVE_REGISTRY only), so they never depend on, or touch,
// the real file. process.exitCode is saved and restored around every case so a deliberate guard
// failure here can never fail the surrounding run.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  LIVE_REGISTRY,
  digestRegistry,
  compareRegistryDigest,
  setup,
  teardown,
} from "../_helpers/live-registry-guard.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const realExistsSync = fs.existsSync;
const realReadFileSync = fs.readFileSync;

let savedExitCode;
let tmpDir;
const fake = { exists: true, bytes: Buffer.from("") };

function stubLiveRegistry() {
  vi.spyOn(fs, "existsSync").mockImplementation((p, ...rest) =>
    path.resolve(String(p)) === LIVE_REGISTRY ? fake.exists : realExistsSync(p, ...rest),
  );
  vi.spyOn(fs, "readFileSync").mockImplementation((p, ...rest) =>
    path.resolve(String(p)) === LIVE_REGISTRY ? fake.bytes : realReadFileSync(p, ...rest),
  );
}

beforeEach(() => {
  savedExitCode = process.exitCode;
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rks-live-guard-"));
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = savedExitCode;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("live-registry-guard digest helpers", () => {
  it("LIVE_REGISTRY resolves to <repoRoot>/projects/index.jsonl", () => {
    expect(LIVE_REGISTRY).toBe(path.join(REPO_ROOT, "projects", "index.jsonl"));
  });

  it("digestRegistry returns absent for a missing file and the sha256 hex of an existing file", () => {
    const file = path.join(tmpDir, "index.jsonl");
    expect(digestRegistry(file)).toBe("absent");
    fs.writeFileSync(file, "{\"id\":\"a\"}\n");
    const expected = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
    expect(digestRegistry(file)).toBe(expected);
  });

  it("compareRegistryDigest is ok for equal digests and names the file, both digests and RKS_REGISTRY_PATH when they differ", () => {
    const file = path.join(tmpDir, "index.jsonl");
    expect(compareRegistryDigest("abc", "abc", file).ok).toBe(true);
    const result = compareRegistryDigest("absent", "def123", file);
    expect(result.ok).toBe(false);
    expect(result.message).toContain(file);
    expect(result.message).toContain("absent");
    expect(result.message).toContain("def123");
    expect(result.message).toContain("RKS_REGISTRY_PATH");
  });
});

describe("live-registry-guard setup/teardown", () => {
  it("teardown is silent and leaves process.exitCode unchanged when the digest is unchanged", () => {
    stubLiveRegistry();
    fake.exists = true;
    fake.bytes = Buffer.from("same\n");
    process.exitCode = undefined;
    setup();
    expect(() => teardown()).not.toThrow();
    expect(process.exitCode).toBeUndefined();
  });

  it("teardown throws and sets process.exitCode to 1 when the content changed", () => {
    stubLiveRegistry();
    fake.exists = true;
    fake.bytes = Buffer.from("before\n");
    setup();
    fake.bytes = Buffer.from("before\nafter\n");
    expect(() => teardown()).toThrow(LIVE_REGISTRY);
    expect(process.exitCode).toBe(1);
  });

  it("teardown throws and sets process.exitCode to 1 on an absent -> present transition", () => {
    stubLiveRegistry();
    fake.exists = false;
    setup();
    fake.exists = true;
    fake.bytes = Buffer.from("{\"id\":\"planted\"}\n");
    expect(() => teardown()).toThrow(/absent/);
    expect(process.exitCode).toBe(1);
  });

  it("teardown throws and sets process.exitCode to 1 on a present -> absent transition", () => {
    stubLiveRegistry();
    fake.exists = true;
    fake.bytes = Buffer.from("{\"id\":\"kept\"}\n");
    setup();
    fake.exists = false;
    expect(() => teardown()).toThrow(/absent/);
    expect(process.exitCode).toBe(1);
  });

  it("setup and teardown never write, truncate, rename or delete the live registry", () => {
    stubLiveRegistry();
    const mutators = ["writeFileSync", "appendFileSync", "truncateSync", "renameSync", "unlinkSync", "rmSync", "copyFileSync"]
      .map((name) => vi.spyOn(fs, name));
    fake.exists = true;
    fake.bytes = Buffer.from("one\n");
    setup();
    fake.bytes = Buffer.from("two\n");
    expect(() => teardown()).toThrow();
    for (const spy of mutators) {
      expect(spy.mock.calls.some((c) => path.resolve(String(c[0])) === LIVE_REGISTRY)).toBe(false);
    }
  });

  it("setup then teardown against the real unmodified registry is silent", () => {
    process.exitCode = undefined;
    setup();
    expect(() => teardown()).not.toThrow();
    expect(process.exitCode).toBeUndefined();
  });
});

const MIGRATED = [
  "tests/project-init-attach-e2e.test.mjs",
  "tests/apply.test.mjs",
  "tests/unit/exec-stranded-reset.test.mjs",
  "tests/unit/exec-write-ledger-provenance.test.mjs",
  "tests/integration/exec-abort-cleanup-observed.test.mjs",
];

describe("migrated writer tests use a temp registry", () => {
  it("each of the five migrated files builds no <repoRoot>/projects/index.jsonl path and sets RKS_REGISTRY_PATH", () => {
    for (const rel of MIGRATED) {
      const src = realReadFileSync(path.join(REPO_ROOT, rel), "utf8");
      expect(src, rel).not.toMatch(/repoRoot\s*,\s*["']projects["']\s*,\s*["']index\.jsonl["']/);
      expect(src, rel).toContain("process.env.RKS_REGISTRY_PATH");
    }
  });
});
