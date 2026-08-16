import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { loadPublishProfiles } from "../../packages/mcp-rks/src/server/publish.mjs";

const ROOT = path.join(fileURLToPath(import.meta.url), "../../..");
const TEMPLATE_PROFILES_PATH = path.join(
  ROOT,
  "templates/generic/.routekit/publish-profiles.yaml"
);

const raw = fs.readFileSync(TEMPLATE_PROFILES_PATH, "utf-8");
const config = yaml.load(raw);
const notesPublic = config?.profiles?.["notes-public"];

describe("publish-profiles.yaml — notes-public profile presence", () => {
  it("contains a top-level profiles.notes-public key", () => {
    expect(config.profiles).toBeDefined();
    expect(config.profiles["notes-public"]).toBeDefined();
  });
});

describe("publish-profiles.yaml — notes-public exclude list", () => {
  it("excludes .routekit/", () => {
    expect(notesPublic.exclude).toContain(".routekit/");
  });

  it("excludes .rks/", () => {
    expect(notesPublic.exclude).toContain(".rks/");
  });

  it("excludes packages/", () => {
    expect(notesPublic.exclude).toContain("packages/");
  });

  it("excludes templates/", () => {
    expect(notesPublic.exclude).toContain("templates/");
  });

  it("excludes CLAUDE.md", () => {
    expect(notesPublic.exclude).toContain("CLAUDE.md");
  });

  it("excludes projects/", () => {
    expect(notesPublic.exclude).toContain("projects/");
  });

  it("does NOT globally exclude notes/ (transforms act as allowlist)", () => {
    expect(notesPublic.exclude).not.toContain("notes/");
    expect(notesPublic.exclude).not.toContain("notes/**");
  });
});

describe("publish-profiles.yaml — notes-public transforms", () => {
  it("has exactly three transform rules", () => {
    expect(notesPublic.transforms).toHaveLength(3);
  });

  it("first rule transforms notes/canon.** → notes/rks.canon.{rest}", () => {
    const rule = notesPublic.transforms[0];
    expect(rule.match).toBe("notes/canon.**");
    expect(rule.rename).toBe("notes/rks.canon.{rest}");
  });

  it("second rule transforms notes/how-to.** → notes/rks.how-to.{rest}", () => {
    const rule = notesPublic.transforms[1];
    expect(rule.match).toBe("notes/how-to.**");
    expect(rule.rename).toBe("notes/rks.how-to.{rest}");
  });

  it("third rule transforms notes/research.public.** → notes/rks.research.public.{rest}", () => {
    const rule = notesPublic.transforms[2];
    expect(rule.match).toBe("notes/research.public.**");
    expect(rule.rename).toBe("notes/rks.research.public.{rest}");
  });
});

describe("publish-profiles.yaml — rks-public-docs remote", () => {
  const remote = config?.remotes?.["rks-public-docs"];

  it("rks-public-docs remote entry is present", () => {
    expect(remote).toBeDefined();
  });

  it("url is git@github.com:routekit-hq/rks-docs.git", () => {
    expect(remote?.url).toBe("git@github.com:routekit-hq/rks-docs.git");
  });

  it("profile is notes-public", () => {
    expect(remote?.profile).toBe("notes-public");
  });

  it("branch is main", () => {
    expect(remote?.branch).toBe("main");
  });
});

describe("publish-profiles.yaml — loadPublishProfiles integration", () => {
  it("returns notes-public profile with correct exclude and transforms when called against template", () => {
    const templateDir = path.join(ROOT, "templates/generic");
    const result = loadPublishProfiles(templateDir);
    const profile = result.profiles?.["notes-public"];

    expect(profile).toBeDefined();
    expect(profile.exclude).toContain(".routekit/");
    expect(profile.transforms).toHaveLength(3);
    expect(profile.transforms[0]).toEqual({
      match: "notes/canon.**",
      rename: "notes/rks.canon.{rest}",
    });
  });
});

describe("publish-profiles.yaml — existing profiles unchanged", () => {
  it("full profile still exists with empty exclude array", () => {
    const full = config.profiles?.["full"];
    expect(full).toBeDefined();
    expect(full.exclude).toEqual([]);
  });

  it("docs-included profile exclude list is unchanged", () => {
    const docsIncluded = config.profiles?.["docs-included"];
    expect(docsIncluded).toBeDefined();
    expect(docsIncluded.exclude).toContain(".routekit/");
    expect(docsIncluded.exclude).toContain(".rks/");
    expect(docsIncluded.exclude).toContain("CLAUDE.md");
    expect(docsIncluded.exclude).toContain("projects/");
    expect(docsIncluded.exclude).not.toContain("packages/");
  });

  it("app-only profile exclude list is unchanged", () => {
    const appOnly = config.profiles?.["app-only"];
    expect(appOnly).toBeDefined();
    expect(appOnly.exclude).toContain("notes/");
    expect(appOnly.exclude).toContain("*.md");
  });
});
