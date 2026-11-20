// backlog.fix.precommands-arch-digest-binding: preCommands bound to the ARCH subject digest, hashed only when present.
//
// testRequirement -> test mapping (TRn = the story's nth testRequirement):
//   TR1  "pins all four note mappers for a note without preCommands"
//   TR2  "preCommands null equals preCommands absent"
//   TR3  "adding a preCommands entry changes each note mapper digest"
//   TR4  "editing a preCommands entry changes each note mapper digest"
//   TR5  "preCommands [] differs from absent and from null"
//   TR6  "a single-string preCommands value changes each note mapper digest"
//   TR7  "object-form wrappers treat undefined as omitted and hash a non-empty list"
//   TR8  "ARCH_SUBJECT_VERSION stays 2"
//   TR9  "TOOL_DESCRIPTION names preCommands as a digest input"
//   TR10 "a preCommands entry added or edited after approval reports changed true, gated true"
//   TR11 "assertStoryUnchangedSinceArch returns the observed check result"
//   TR12 "assertStoryUnchangedSinceArch throws story_changed_since_arch on a post-approval preCommands edit"
// No subprocess is spawned in this file.
import { describe, it, expect } from "vitest";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { parseFrontmatter } from "../../packages/mcp-rks/src/shared/frontmatter.mjs";
import {
  ARCH_SUBJECT_VERSION,
  TOOL_DESCRIPTION,
  subjectDigest,
  v1SubjectDigest,
  legacySubjectDigest,
  preCarveOutSubjectDigest,
  noteSubjectDigest,
  noteV1SubjectDigest,
  noteLegacySubjectDigest,
  notePreCarveOutSubjectDigest,
  storyChangedSinceArch,
} from "../../packages/mcp-rks/src/workflow/arch-verdict.mjs";
import { assertStoryUnchangedSinceArch } from "../../packages/mcp-rks/src/server/exec.mjs";

const STORY = "backlog.fix.digest-fixture";

// The fixture note. "Some solution  text." carries a double space so the v1 (non-normalised) and current
// (whitespace-normalised) digests differ.
const NOTE = `---\nid: "${STORY}"\ntitle: "fixture"\nphase: "ready"\ntargetFiles:\n  - path: "src/a.mjs"\n    op: "edit"\n    desc: "edit a"\ntestRequirements:\n  - "first requirement"\n  - "second requirement"\n---\n\n## Problem\n\nSome problem text.\n\n## Solution\n\nSome solution  text.\n`;
const FIXTURE = parseFrontmatter(NOTE);

// Literal digests captured from the pre-change implementation (arch-verdict.mjs unchanged between @398c0120d
// and the build base @c20c0c955) for FIXTURE (no preCommands).
const PINNED = {
  current: "25294dc64c4d9c7002018e8b51ed557f",
  v1: "0ae4aa724ffb24abcc783467cedc1ad6",
  legacy: "1896287cb70edba2b06d4e628f951234",
  preCarveOut: "0ae4aa724ffb24abcc783467cedc1ad6",
};

const MAPPERS = {
  current: noteSubjectDigest,
  v1: noteV1SubjectDigest,
  legacy: noteLegacySubjectDigest,
  preCarveOut: notePreCarveOutSubjectDigest,
};
const WRAPPERS = { subjectDigest, v1SubjectDigest, legacySubjectDigest, preCarveOutSubjectDigest };

const withPre = (value) => ({ ...FIXTURE, data: { ...FIXTURE.data, preCommands: value } });
const digestsOf = (parsed) => Object.fromEntries(Object.entries(MAPPERS).map(([k, fn]) => [k, fn(parsed)]));

describe("digest binding: absent preCommands keeps every digest byte-identical", () => {
  it("pins all four note mappers for a note without preCommands", () => {
    expect(FIXTURE.data.preCommands).toBeUndefined();
    expect(digestsOf(FIXTURE)).toEqual(PINNED);
  });

  it("preCommands null equals preCommands absent", () => {
    expect(digestsOf(withPre(null))).toEqual(PINNED);
    // Parsed from YAML too, not only constructed.
    const parsedNull = parseFrontmatter(NOTE.replace('phase: "ready"\n', 'phase: "ready"\npreCommands: null\n'));
    expect(parsedNull.data.preCommands).toBeNull();
    expect(digestsOf(parsedNull)).toEqual(PINNED);
  });

  it("preCommands [] differs from absent and from null", () => {
    const empty = digestsOf(withPre([]));
    const nul = digestsOf(withPre(null));
    for (const k of Object.keys(MAPPERS)) {
      expect(empty[k], k).not.toBe(PINNED[k]);
      expect(empty[k], k).not.toBe(nul[k]);
    }
  });
});

describe("digest binding: present preCommands change every digest", () => {
  it("adding a preCommands entry changes each note mapper digest", () => {
    const one = digestsOf(withPre(["npm install"]));
    for (const k of Object.keys(MAPPERS)) {
      expect(one[k], k).toMatch(/^[0-9a-f]{32}$/);
      expect(one[k], k).not.toBe(PINNED[k]);
    }
  });

  it("editing a preCommands entry changes each note mapper digest", () => {
    const a = digestsOf(withPre(["npm install"]));
    const b = digestsOf(withPre(["npm ci"]));
    for (const k of Object.keys(MAPPERS)) expect(b[k], k).not.toBe(a[k]);
  });

  it("a single-string preCommands value changes each note mapper digest", () => {
    const single = digestsOf(withPre("npm install"));
    for (const k of Object.keys(MAPPERS)) expect(single[k], k).not.toBe(PINNED[k]);
  });

  it("TOOL_DESCRIPTION names preCommands as a digest input", () => {
    expect(TOOL_DESCRIPTION).toContain("preCommands");
    expect(TOOL_DESCRIPTION).toContain("targetFiles");
    expect(TOOL_DESCRIPTION).toContain("testRequirements");
  });

  it("object-form wrappers treat undefined as omitted and hash a non-empty list", () => {
    const base = { body: FIXTURE.content, targetFiles: FIXTURE.data.targetFiles, testRequirements: FIXTURE.data.testRequirements };
    for (const [name, fn] of Object.entries(WRAPPERS)) {
      const omitted = fn(base);
      expect(fn({ ...base, preCommands: undefined }), name).toBe(omitted);
      expect(fn({ ...base, preCommands: ["npm install"] }), name).not.toBe(omitted);
    }
  });

  it("ARCH_SUBJECT_VERSION stays 2", () => {
    expect(ARCH_SUBJECT_VERSION).toBe(2);
  });
});

/** An approved, versioned story whose arch_subject was recorded over `recordedPre`, now carrying `currentPre`. */
function approvedNote(recordedPre, currentPre, { versioned = true } = {}) {
  const recordedOn = recordedPre === undefined ? FIXTURE : withPre(recordedPre);
  const data = { ...FIXTURE.data, arch_verdict: "approved", arch_subject: noteSubjectDigest(recordedOn) };
  if (versioned) data.arch_subject_version = "2";
  if (currentPre !== undefined) data.preCommands = currentPre;
  return { data, content: FIXTURE.content };
}
const asStory = (parsed) => ({ frontmatter: parsed.data, body: parsed.content });

describe("storyChangedSinceArch and assertStoryUnchangedSinceArch on preCommands", () => {
  it("a preCommands entry added or edited after approval reports changed true, gated true", () => {
    const added = storyChangedSinceArch(approvedNote(undefined, ["npm install"]), STORY);
    expect(added.changed).toBe(true);
    expect(added.gated).toBe(true);
    const edited = storyChangedSinceArch(approvedNote(["npm install"], ["npm ci"]), STORY);
    expect(edited.changed).toBe(true);
    expect(edited.gated).toBe(true);
    // Positive control: the same approval over the same preCommands is unchanged.
    const same = storyChangedSinceArch(approvedNote(["npm install"], ["npm install"]), STORY);
    expect(same.changed).toBe(false);
    expect(same.gated).toBe(true);
  });

  it("assertStoryUnchangedSinceArch returns the observed check result", () => {
    const observed = { changed: false, gated: true, failedClosed: false, recorded: "x", recordedVersion: "2", current: "x", message: null };
    const story = asStory(approvedNote(undefined, undefined));
    expect(assertStoryUnchangedSinceArch(story, STORY, () => observed)).toBe(observed);

    const gated = assertStoryUnchangedSinceArch(asStory(approvedNote(["npm install"], ["npm install"])), STORY);
    expect(gated.gated).toBe(true);
    expect(gated.changed).toBe(false);

    const unapproved = assertStoryUnchangedSinceArch(asStory({ data: { ...FIXTURE.data, preCommands: ["npm install"] }, content: FIXTURE.content }), STORY);
    expect(unapproved.gated).toBe(false);
    expect(unapproved.changed).toBe(false);

    const unversioned = assertStoryUnchangedSinceArch(asStory(approvedNote(["npm install"], ["npm install"], { versioned: false })), STORY);
    expect(unversioned.gated).toBe(false);
    expect(unversioned.ungatedReason).toBe("arch_subject_unversioned");
  });

  it("assertStoryUnchangedSinceArch throws story_changed_since_arch on a post-approval preCommands edit", () => {
    let err;
    try {
      assertStoryUnchangedSinceArch(asStory(approvedNote(undefined, ["npm install"])), STORY);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(McpError);
    expect(err.message).toContain("story_changed_since_arch");
    expect(err.message).toContain(STORY);
  });
});
