/**
 * Pins the corrected user-facing release notes for v0.89.0 in CHANGELOG.md.
 * (backlog.docs.release-notes-correct-0-89-0)
 *
 * Static doc-content test: reads CHANGELOG.md and the story notes' frontmatter,
 * no fixtures, no subprocesses.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CHANGELOG = fs.readFileSync(path.resolve('CHANGELOG.md'), 'utf8').split('\n');
const NOTES_DIR = path.resolve('notes');

const VERSION = '0.89.0';
const HEADING = '## [0.89.0] - 2026-11-12';
const NEXT_HEADING = '## [0.88.0] - 2026-11-11';
// The 0.77.0 work that was wrongly listed under 0.89.0, and the 0.77.0 line that already describes it.
const ORIGIN_VERSION = '0.77.0';
const MISPLACED_PHRASE = '`llm.supportedProviders`';
const ORIGIN_LINE = '- Fix: `llm.supportedProviders` no longer lists `google`';
const GROUPS = ['Added', 'Changed', 'Fixed', 'Security', 'Removed', 'Internal'];

const HEADING_RE = /^## \[(\d+)\.(\d+)\.(\d+)\] - \d{4}-\d{2}-\d{2}$/;
const COMMIT_SUBJECT_RE = /^- (feat|fix|docs|chore|refactor|test|ci|build|perf|style|revert)(\([^)]*\))?!?: /;
// `### Added` as in 0.88.0, or `## Added` if that level is kept; one level per body.
const GROUP_RE = /^(#{2,3}) (\S+)$/;
const BULLET_RE = /^- \S/;
const STORY_ID_RE = /backlog\./;
// The private contributor's names are built from character codes at runtime so that
// this file's own source never spells either of them (tests/** reaches the public mirror).
const PRIVATE_NAME_RE = new RegExp(
  [[115, 105, 109, 111, 110], [119, 101, 110, 109, 111, 117, 116, 104]]
    .map((c) => String.fromCharCode(...c))
    .join('|'),
  'i',
);
const SELF_SOURCE = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8');

// normalizedStoryId -> { line: '<durable substring of its body line>' } | { omitted: '<reason>' }
// normalizedStoryId strips a 'z_implemented.' segment so archival renames do not break the map.
const COVERAGE = {
  // Added
  'backlog.feat.release-notes-account-for-released-stories': { line: 'Release notes coverage check' },
  // Changed
  'backlog.fix.rag-compact-takes-embed-lock': { line: 'RAG compaction now takes the embed lock' },
  // Fixed
  'backlog.fix.rag-embed-on-commit-uses-acquire-embed-lock': { line: 'The post-commit RAG embed hook' },
  'backlog.fix.rag-embed-lock-reclaim-guard-identity-removal': { line: 'Embed-lock reclaim no longer deletes' },
  'backlog.fix.rag-embed-server-stale-module-unreported': { line: '`embedCodeStale`' },
  'backlog.fix.dendron-note-write-surfaces-stale-embed-code': { line: '`ragEmbedWarning`' },
  'backlog.fix.release-notes-coverage-review-followups': { line: 'Release-notes drafts now read multi-line' },
  // Internal
  'backlog.design.rag-embed-lock-kernel-binding-spike': { line: 'kernel-held embed lock' },
  'backlog.docs.release-notes-rewrite-0-88-0': { line: 'Rewrote the v0.88.0 release notes' },
  'backlog.fix.telemetry-triage-verdict-release-notes-coverage': { line: 'telemetry-triage verdict' },
};

function sections(lines) {
  // [{ version, headingIndex, body }] where body is the lines strictly between a
  // `## [x.y.z] - date` heading and the next `## [` heading (or EOF)
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = HEADING_RE.exec(lines[i]);
    if (!m) continue;
    let j = i + 1;
    while (j < lines.length && !lines[j].startsWith('## [')) j++;
    out.push({ version: `${m[1]}.${m[2]}.${m[3]}`, headingIndex: i, body: lines.slice(i + 1, j) });
  }
  return out;
}

function normalizeId(id) {
  return id.replace(/(^|\.)z_implemented\./, '$1');
}

function frontmatterOf(text) {
  const lines = text.split('\n');
  if (lines[0].trim() !== '---') return null;
  const end = lines.indexOf('---', 1);
  if (end < 0) return null;
  return lines.slice(1, end);
}

function releasedStories(version) {
  // frontmatter-only: a `releasedIn` mention in a note's prose does not count
  const ids = [];
  for (const name of fs.readdirSync(NOTES_DIR)) {
    if (!name.endsWith('.md')) continue;
    const full = path.join(NOTES_DIR, name);
    if (!fs.statSync(full).isFile()) continue;
    const fm = frontmatterOf(fs.readFileSync(full, 'utf8'));
    if (!fm) continue;
    for (const line of fm) {
      const m = /^releasedIn:\s*["']?([^"'\s]+)["']?\s*$/.exec(line);
      if (m) {
        if (m[1] === version) ids.push(normalizeId(name.slice(0, -'.md'.length)));
        break;
      }
    }
  }
  return ids;
}

const parseVersion = (v) => v.split('.').map(Number);
const compareVersions = (a, b) => {
  const [x, y] = [parseVersion(a), parseVersion(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
};

const SECTIONS = sections(CHANGELOG);
const bodyFor = (version) => {
  const s = SECTIONS.find((x) => x.version === version);
  if (!s) throw new Error(`no CHANGELOG section for ${version}`);
  return s.body;
};
const body = () => bodyFor(VERSION);
const nonBlank = () => body().filter((l) => l.trim() !== '');

describe('CHANGELOG 0.89.0 heading', () => {
  it('the 0.89.0 heading appears exactly once, is followed by the 0.88.0 heading, and has only newer release headings above it', () => {
    expect(CHANGELOG.filter((l) => l === HEADING).length).toBe(1);
    const at = SECTIONS.findIndex((s) => CHANGELOG[s.headingIndex] === HEADING);
    expect(at).toBeGreaterThanOrEqual(0);
    expect(CHANGELOG[SECTIONS[at + 1]?.headingIndex]).toBe(NEXT_HEADING);
    for (const s of SECTIONS.slice(0, at)) expect(compareVersions(s.version, VERSION), s.version).toBeGreaterThan(0);
  });

  it('this test file names no release newer than 0.89.0', () => {
    const versions = [...SELF_SOURCE.matchAll(/\b(\d+)\.(\d+)\.(\d+)\b/g)].map((m) => `${m[1]}.${m[2]}.${m[3]}`);
    expect(versions.length).toBeGreaterThan(0);
    expect(versions.filter((v) => compareVersions(v, VERSION) > 0)).toEqual([]);
  });
});

describe('CHANGELOG 0.89.0 body shape', () => {
  it('body starts and ends with exactly one blank line and has content', () => {
    const b = body();
    expect(b.length).toBeGreaterThanOrEqual(3);
    expect(b[0]).toBe('');
    expect(b[1]).not.toBe('');
    expect(b.at(-1)).toBe('');
    expect(b.at(-2)).not.toBe('');
  });

  it('every non-blank body line is a group heading or a bullet', () => {
    const offenders = nonBlank().filter((l) => !GROUP_RE.test(l) && !BULLET_RE.test(l));
    expect(offenders).toEqual([]);
  });

  it('group headings come from the allowed set, share one heading level, appear at most once each and in order, and each has a bullet', () => {
    const lines = nonBlank();
    const matches = lines.map((l) => GROUP_RE.exec(l)).filter(Boolean);
    const groups = matches.map((m) => m[2]);
    expect(groups.length).toBeGreaterThan(0);
    expect(new Set(matches.map((m) => m[1])).size).toBe(1);
    for (const g of groups) expect(GROUPS, g).toContain(g);
    expect(new Set(groups).size).toBe(groups.length);
    const order = groups.map((g) => GROUPS.indexOf(g));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(GROUP_RE.test(lines[0])).toBe(true);
    lines.forEach((l, i) => {
      if (GROUP_RE.test(l)) expect(BULLET_RE.test(lines[i + 1] ?? ''), l).toBe(true);
    });
  });

  it('no body line is a conventional-commit subject', () => {
    expect(body().filter((l) => COMMIT_SUBJECT_RE.test(l))).toEqual([]);
  });

  it('no body line names a story id', () => {
    expect(body().filter((l) => STORY_ID_RE.test(l))).toEqual([]);
  });

  it('no body line names the private contributor in any case', () => {
    expect(body().filter((l) => PRIVATE_NAME_RE.test(l))).toEqual([]);
  });

  it("this test file's own source does not name the private contributor in any case", () => {
    expect(SELF_SOURCE.length).toBeGreaterThan(0);
    expect(SELF_SOURCE.split('\n').filter((l) => PRIVATE_NAME_RE.test(l))).toEqual([]);
  });
});

describe('CHANGELOG 0.89.0 misplaced 0.77.0 bullet', () => {
  it('no 0.89.0 body line mentions `llm.supportedProviders`', () => {
    expect(body().filter((l) => l.includes(MISPLACED_PHRASE))).toEqual([]);
  });

  it('the 0.77.0 entry still describes the `llm.supportedProviders` change', () => {
    expect(bodyFor(ORIGIN_VERSION).filter((l) => l.startsWith(ORIGIN_LINE)).length).toBe(1);
  });
});

describe('CHANGELOG 0.89.0 story coverage', () => {
  it('COVERAGE keys equal the stories whose frontmatter releasedIn is 0.89.0', () => {
    const released = releasedStories(VERSION).sort();
    expect(released.length).toBeGreaterThan(0);
    expect(Object.keys(COVERAGE).sort()).toEqual(released);
  });

  it("every covered story's line is in the body and every omission has a reason", () => {
    const lines = nonBlank();
    for (const [id, entry] of Object.entries(COVERAGE)) {
      if ('line' in entry) {
        expect(typeof entry.line, id).toBe('string');
        expect(entry.line.length, id).toBeGreaterThan(0);
        expect(lines.some((l) => BULLET_RE.test(l) && l.includes(entry.line)), `${id}: ${entry.line}`).toBe(true);
      } else {
        expect(typeof entry.omitted, id).toBe('string');
        expect(entry.omitted.trim().length, id).toBeGreaterThan(0);
      }
    }
  });

  it('every bullet line is claimed by at least one COVERAGE entry', () => {
    const claims = Object.values(COVERAGE).filter((e) => 'line' in e).map((e) => e.line);
    const orphans = nonBlank().filter((l) => BULLET_RE.test(l) && !claims.some((c) => l.includes(c)));
    expect(orphans).toEqual([]);
  });
});
