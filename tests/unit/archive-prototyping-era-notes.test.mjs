import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RESERVED_NAMESPACES } from "../../packages/rag/src/utils.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const NOTES = path.join(ROOT, "notes");
const HOW_TO = path.join(NOTES, "how-to.md");
const OLD_CTX = path.join(NOTES, "context.routekit-shell.md");
const OLD_STATE = path.join(NOTES, "context.routekit-shell.current-state.md");
const NEW_CTX_BASE = "z_archive.context.routekit-shell.md";
const NEW_STATE_BASE = "z_archive.context.routekit-shell.current-state.md";
const NEW_CTX = path.join(NOTES, NEW_CTX_BASE);
const NEW_STATE = path.join(NOTES, NEW_STATE_BASE);

// Shell-only notes: none of these reach the public mirror, but tests/** does.
const SHELL = fs.existsSync(HOW_TO);

function read(p) {
  try {
    return fs.readFileSync(p, "utf-8");
  } catch {
    return "";
  }
}

function philosophySection(src) {
  const start = src.search(/^## Philosophy\s*$/m);
  if (start < 0) return "";
  const rest = src.slice(start + "## Philosophy".length);
  const next = rest.search(/^## /m);
  return next < 0 ? rest : rest.slice(0, next);
}

describe.skipIf(!SHELL)("archive-prototyping-era-notes — archive renames", () => {
  it("notes/context.routekit-shell.md no longer exists", () => {
    expect(fs.existsSync(OLD_CTX)).toBe(false);
  });

  it("notes/context.routekit-shell.current-state.md no longer exists", () => {
    expect(fs.existsSync(OLD_STATE)).toBe(false);
  });

  it("notes/z_archive.context.routekit-shell.md exists with its original id and body", () => {
    const src = read(NEW_CTX);
    expect(src).toContain("id: l2fh7z19qforo6f198absre");
    expect(src).toContain("compresses the timeline from idea to validated prototype");
  });

  it("notes/z_archive.context.routekit-shell.current-state.md exists with its original id and body", () => {
    const src = read(NEW_STATE);
    expect(src).toContain("id: os2ceo7sq8l6yt9istadfys");
    expect(src).toContain("Governance/testing is limited to smoke scripts.");
  });

  it("both archived basenames start with a RESERVED_NAMESPACES member", () => {
    for (const base of [NEW_CTX_BASE, NEW_STATE_BASE]) {
      expect(RESERVED_NAMESPACES.some((ns) => base.startsWith(ns))).toBe(true);
    }
  });
});

describe.skipIf(!SHELL)("archive-prototyping-era-notes — how-to hub Philosophy", () => {
  const src = read(HOW_TO);

  it("notes/how-to.md contains no rapid prototyping phrase", () => {
    expect(src).not.toMatch(/rapid prototyping/i);
  });

  it("notes/how-to.md contains no working prototype phrase", () => {
    expect(src).not.toMatch(/working prototype/i);
  });

  it("the Philosophy section links public.canon.what-is-rks", () => {
    const section = philosophySection(src);
    expect(section.length).toBeGreaterThan(0);
    expect(section).toContain("[[public.canon.what-is-rks");
  });

  it("every pre-existing heading is preserved", () => {
    for (const heading of [
      "## Overview",
      "## Quick Navigation",
      "### Getting Started",
      "### Project Structure",
      "### Development Workflow",
      "### Design System",
      "### RAG Integration",
      "### Deployment",
      "## Philosophy",
    ]) {
      expect(src).toMatch(new RegExp(`^${heading}\\s*$`, "m"));
    }
  });
});
