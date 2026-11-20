import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import {
  loadPolicy,
  classifyId,
  classifyExpression,
  resolveLicenseExpr,
  classifyPackage,
  getSelfPackages,
  collectPackages,
  auditPackages,
} from "../../scripts/check-licenses.mjs";

// The dependency-license CI gate. Deliberately STRICTER than AGPL compatibility — it keeps
// the codebase re-licensable for the commercial/Pro surface. These tests pin the policy
// (against the REAL .routekit/license-policy.yaml) so a future "relaxation" reddens CI.

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "../..");
const SCRIPT = join(ROOT, "scripts/check-licenses.mjs");
const policy = loadPolicy(join(ROOT, ".routekit/license-policy.yaml"));

describe("loadPolicy — real policy shape", () => {
  it("loads allow/deny/flag sets and the unknownIsDeny flag", () => {
    expect(policy.allow.has("MIT")).toBe(true);
    expect(policy.deny.has("GPL-3.0-only")).toBe(true);
    expect(policy.deny.has("AGPL-3.0-or-later")).toBe(true);
    expect(policy.flag.has("LGPL-3.0-only")).toBe(true);
    expect(policy.unknownIsDeny).toBe(false);
  });
});

describe("classifyId", () => {
  it("ALLOW permissive licenses", () => {
    for (const id of ["MIT", "ISC", "BSD-2-Clause", "BSD-3-Clause", "Apache-2.0", "0BSD", "CC0-1.0", "Unlicense"]) {
      expect(classifyId(id, policy)).toBe("allow");
    }
  });
  it("DENY strong copyleft", () => {
    for (const id of ["GPL-3.0-only", "GPL-2.0-or-later", "AGPL-3.0-only", "AGPL-3.0-or-later"]) {
      expect(classifyId(id, policy)).toBe("deny");
    }
  });
  it("FLAG weak copyleft", () => {
    for (const id of ["LGPL-3.0-only", "MPL-2.0", "EPL-2.0"]) {
      expect(classifyId(id, policy)).toBe("flag");
    }
  });
  it("UNKNOWN for unrecognized / empty / null", () => {
    expect(classifyId("Weird-License-9000", policy)).toBe("unknown");
    expect(classifyId("", policy)).toBe("unknown");
    expect(classifyId(null, policy)).toBe("unknown");
  });
  it("family fallback catches legacy/short copyleft forms not in the explicit lists", () => {
    expect(classifyId("GPL-2.0", policy)).toBe("deny"); // legacy bare form
    expect(classifyId("GPL-2.0+", policy)).toBe("deny"); // legacy + form (trailing + stripped)
    expect(classifyId("AGPL-3.0", policy)).toBe("deny");
    expect(classifyId("LGPL-2.0", policy)).toBe("flag");
  });
});

describe("classifyExpression — SPDX OR/AND/parens/WITH", () => {
  it("OR = least-restrictive operand wins (consumer may elect the permissive branch)", () => {
    expect(classifyExpression("(MIT OR GPL-3.0-only)", policy)).toBe("allow");
    expect(classifyExpression("MIT OR GPL-3.0-only", policy)).toBe("allow");
    expect(classifyExpression("(LGPL-3.0-only OR GPL-3.0-only)", policy)).toBe("flag");
    expect(classifyExpression("(GPL-3.0-only OR AGPL-3.0-only)", policy)).toBe("deny");
  });
  it("AND = most-restrictive operand wins (all operands required)", () => {
    expect(classifyExpression("(MIT AND GPL-3.0-only)", policy)).toBe("deny");
    expect(classifyExpression("MIT AND Apache-2.0", policy)).toBe("allow");
    expect(classifyExpression("(MIT AND LGPL-3.0-only)", policy)).toBe("flag");
  });
  it("AND binds tighter than OR", () => {
    // MIT OR (GPL AND AGPL) → allow (MIT branch wins)
    expect(classifyExpression("MIT OR GPL-3.0-only AND AGPL-3.0-only", policy)).toBe("allow");
  });
  it("drops a 'WITH <exception>' and classifies by the base license", () => {
    expect(classifyExpression("Apache-2.0 WITH LLVM-exception", policy)).toBe("allow");
    expect(classifyExpression("GPL-3.0-only WITH Classpath-exception-2.0", policy)).toBe("deny");
  });
  it("a bare identifier evaluates like classifyId", () => {
    expect(classifyExpression("MIT", policy)).toBe("allow");
    expect(classifyExpression("", policy)).toBe("unknown");
  });
});

describe("resolveLicenseExpr — modern + legacy package.json shapes", () => {
  it("modern string license", () => {
    expect(resolveLicenseExpr({ license: "MIT" })).toBe("MIT");
  });
  it("legacy object license {type,url}", () => {
    expect(resolveLicenseExpr({ license: { type: "ISC", url: "x" } })).toBe("ISC");
  });
  it("legacy licenses array → OR disjunction", () => {
    expect(resolveLicenseExpr({ licenses: [{ type: "MIT" }, { type: "Apache-2.0" }] })).toBe("MIT OR Apache-2.0");
    expect(resolveLicenseExpr({ licenses: ["MIT", "Apache-2.0"] })).toBe("MIT OR Apache-2.0");
  });
  it("missing license → null", () => {
    expect(resolveLicenseExpr({})).toBeNull();
    expect(resolveLicenseExpr(null)).toBeNull();
  });
});

describe("classifyPackage", () => {
  it("dual-license array with a denied term is ALLOW (OR semantics — pick the clean one)", () => {
    expect(classifyPackage({ licenses: ["MIT", "GPL-3.0-only"] }, policy)).toBe("allow");
  });
  it("missing license → unknown", () => {
    expect(classifyPackage({ name: "x", version: "1.0.0" }, policy)).toBe("unknown");
  });
});

// ---- integration: self-exemption + auditing over a temp node_modules fixture ----

describe("auditPackages + getSelfPackages — self-AGPL exemption, third-party scope", () => {
  let root;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "rks-lic-"));
    // a workspace root that owns an AGPL package under packages/*
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ name: "root-pkg", workspaces: ["packages/*"] }),
    );
    mkdirSync(join(root, "packages", "cli"), { recursive: true });
    writeFileSync(
      join(root, "packages", "cli", "package.json"),
      JSON.stringify({ name: "@routekit/cli", license: "AGPL-3.0-or-later" }),
    );
    // node_modules with a mix: permissive, denied, flagged, and the self package symlinked-in
    const nm = join(root, "node_modules");
    const dep = (name, license) => {
      const dir = join(nm, name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name, version: "1.0.0", license }));
    };
    dep("good-dep", "MIT");
    dep("bad-dep", "GPL-3.0-only");
    dep("weak-dep", "MPL-2.0");
    dep("@routekit/cli", "AGPL-3.0-or-later"); // the workspace package, present in node_modules
    mkdirSync(join(nm, "@scope", "scoped-good"), { recursive: true });
    writeFileSync(
      join(nm, "@scope", "scoped-good", "package.json"),
      JSON.stringify({ name: "@scope/scoped-good", version: "2.0.0", license: "Apache-2.0" }),
    );
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("discovers the workspace package names as self", () => {
    const self = getSelfPackages(root);
    expect(self.has("root-pkg")).toBe(true);
    expect(self.has("@routekit/cli")).toBe(true);
  });

  it("groups third-party deps and EXEMPTS the first-party AGPL package", () => {
    const self = getSelfPackages(root);
    const groups = auditPackages(collectPackages(join(root, "node_modules")), policy, self);

    expect(groups.allow.map((p) => p.name).sort()).toEqual(["@scope/scoped-good", "good-dep"]);
    expect(groups.deny.map((p) => p.name)).toEqual(["bad-dep"]);
    expect(groups.flag.map((p) => p.name)).toEqual(["weak-dep"]);
    // @routekit/cli (AGPL, first-party) must NOT appear anywhere — exempt by construction.
    const all = [...groups.allow, ...groups.deny, ...groups.flag, ...groups.unknown].map((p) => p.name);
    expect(all).not.toContain("@routekit/cli");
  });
});

// ---- CLI exit-code semantics (real subprocess, timeout-guarded) ----

describe("CLI gate — exit codes", () => {
  let root;
  function fixture(deps) {
    root = mkdtempSync(join(tmpdir(), "rks-lic-cli-"));
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "root-pkg", workspaces: ["packages/*"] }));
    mkdirSync(join(root, ".routekit"), { recursive: true });
    // reuse the real policy so the CLI classifies with production rules
    writeFileSync(
      join(root, ".routekit", "license-policy.yaml"),
      readFileSync(join(ROOT, ".routekit/license-policy.yaml"), "utf8"),
    );
    for (const [name, license] of Object.entries(deps)) {
      const dir = join(root, "node_modules", name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name, version: "1.0.0", license }));
    }
    return root;
  }
  afterEach(() => root && rmSync(root, { recursive: true, force: true }));

  const run = (args, cwd) =>
    spawnSync("node", [SCRIPT, ...args], {
      cwd,
      env: { ...process.env, ROUTEKIT_PROJECT_ROOT: cwd },
      encoding: "utf8",
      timeout: 20000,
    });

  it("exits 1 when a DENIED dep is present", () => {
    const r = run([], fixture({ "good-dep": "MIT", "bad-dep": "AGPL-3.0-only" }));
    expect(r.status).toBe(1);
    expect(`${r.stdout}${r.stderr}`).toMatch(/bad-dep/);
  });

  it("exits 0 when all deps are permitted (flag/unknown do not fail the gate)", () => {
    const r = run([], fixture({ "good-dep": "MIT", "weak-dep": "MPL-2.0", "mystery": "Weird-9000" }));
    expect(r.status).toBe(0);
  });

  it("--report exits 0 even with a denied dep present", () => {
    const r = run(["--report"], fixture({ "bad-dep": "GPL-3.0-only" }));
    expect(r.status).toBe(0);
    expect(`${r.stdout}`).toMatch(/bad-dep/);
  });
});
