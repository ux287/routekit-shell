#!/usr/bin/env node
// backlog.chore.backlog-archive-strays-and-stalls — dry-run-first backlog archive sweep.
//
// Default: dry run, writes nothing, prints a report and a digest.
// --apply --expect <digest> recomputes the plan and applies it only when the digest matches, so
// exactly the reviewed set is applied. Apply makes no commit; the caller commits the result.
//
// Flags:
//   --apply                      apply the plan (requires --expect)
//   --expect <digest>            the digest printed by the reviewed dry run
//   --json <path>                also write the report as JSON
//   --fix-existing-archive-ids   rewrite `id` on existing z_archive.backlog.* notes whose id is not
//                                their filename (included in the plan and the digest)
//   --manifest <path>            manifest path (default scripts/backlog-archive-manifest.json)
//   --cutoff <YYYY-MM-DD>        enable the shelved cohort S (backlog.chore.backlog-sweep-shelve-stale-notes);
//                                an explicit date, never "now", so the dry run and the apply agree. The
//                                cutoff enters the digest, so an apply with a different (or no) cutoff
//                                than the reviewed dry run is refused with digest_mismatch
//
// Cohorts (a note is in at most one):
//   A   parsed phase released                      -> backlog.z_implemented.<rest>
//   A'  parsed phase integrated                    -> backlog.z_implemented.<rest>
//   B   manifest doneInCode[] with evidence        -> backlog.z_implemented.<rest>
//   C1  manifest archive[] kind superseded         -> z_archive.backlog.<rest>
//   C2  manifest archive[] kind wont-do            -> z_archive.backlog.<rest>
//   C3  parsed phase decomposed, all children shipped -> backlog.z_implemented.<rest>
//   C4  parsed phase decomposed, no live or held child, not every child shipped -> z_archive.backlog.<rest>,
//       status superseded (backlog.chore.backlog-sweep-decomposed-parent-follows-children)
//   S   (only with --cutoff) unshipped note older than the cutoff -> z_archive.backlog.<rest>, status shelved
// Everything else is held with a reported reason. `phase` is never written on a moved note.
//
// Shelved cohort S (backlog.chore.backlog-sweep-shelve-stale-notes; policy in
// notes/decision.backlog-note-disposition.md). Only the residue that is not selected by any other
// cohort, not named by a manifest list and not decomposed is considered (a decomposed parent is never
// shelved: it follows its children through C3 or C4, and is held while any child is live or held). It is shelved unless it is
// arch-approved, carries releasedIn, has a live unshipped child at plan start (one pass, no fixpoint),
// has an unreadable age (`updated`, falling back to `created`), was updated on or after the cutoff,
// or is named by id in a current paper. An in-flight phase (planned, executing, executed, building) is
// not an exception: such a note is checked for work done in code first (a doneInCode entry moves it in
// cohort B), and is otherwise shelved; the report lists the shelved in-flight notes separately.
// A paper is a research.* or roadmap.* note directly under notes/ (never z_archive.*); it is current
// when its filename date (or, undated, its `updated`) is on or after the cutoff, or when listed in
// manifest currentPapers[] { id, reason }.
// Manifest shelve[] { id, reason } (only consulted with --cutoff): a user-ruled note is shelved even
// when recent or named by a current paper; every other exception holds it shelve_entry_blocked.
// For every S move, other notes' frontmatter supersededBy (string or array element) naming the
// shelved note is rewritten to its new id (supersededByRewrites[]).
//
// Reviewed manifest lists (backlog.chore.backlog-sweep-clear-mechanical-holds), each digest-locked:
//   testReferences[]   { id, file, line, text, use: data|comment } — a test_reference hold is cleared
//                      only when EVERY `<id>.md` reference is listed and its line still contains text
//   duplicates[]       { live, survivor, sha256 } — a target_exists pair (live note + its
//                      backlog.z_implemented.* twin) is resolved: the live copy is deleted when its
//                      sha256 matches, and the survivor keeps the furthest phase and any releasedIn.
//                      Reported in duplicatesResolved[], never in moves[]; no cohort key is added.
//                      Admitted for a z_implemented-kind proposal and for a shelve (cohort S) proposal
//                      whose ONLY existing destination is its z_implemented twin
//                      (backlog.chore.backlog-sweep-residual-mechanical-holds); a shelve proposal with
//                      a z_archive.backlog.* twin, or with both twins, stays held target_exists
//   decomposedChildren[] { id, children[] } — children named only in a decomposed parent's body;
//                      every child must appear in the parent's text, resolve and be shipped
//   decisionTestsAcceptArchive[] { record, test, literal } — a z_archive proposal skips
//                      decision_reference only when EVERY citing decision record has an entry whose
//                      test file exists and contains literal
// Frontmatter childStories[] on a decomposed parent are children too (C3 by the same shipped test).
//
// Decomposed parent follows its children (cohort C4; policy in notes/decision.backlog-note-disposition.md
// item 9). Each child is classified at plan start (one pass, no fixpoint): live (resolves at its live
// backlog.<rest> path, any phase, even with a z_implemented twin), held (named by id in manifest held[],
// with or without a note), shipped (backlog.z_implemented.<rest>), archived (z_archive.backlog.<rest>),
// or missing (declared in childStories[], resolves nowhere, not in held[]). A decomposedChildren[] entry
// that lists no children, or names a child that is not in the parent's text or does not resolve, is a
// manifest defect. C4 applies when at least one child resolves, no child is live or held, there is no
// defect and not every child is shipped; it writes status superseded, supersededBy and decomposedInto
// (the resolved children), missingChildren (only when any) and archiveCohort decomposed-unshipped.
// A held decomposed parent's hold detail lists its live, held and missing children.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseFrontmatter, splitNoteFrontmatter, spliceNoteFrontmatter } from "../packages/mcp-rks/src/shared/frontmatter.mjs";
import { rewriteWikilinks } from "../packages/mcp-rks/src/shared/wikilinks.mjs";
import { VALID_PHASES } from "../packages/mcp-rks/src/workflow/phases.mjs";

export const ARCHIVED_BY = "backlog.chore.backlog-archive-strays-and-stalls";
export const Z_IMPL_PREFIX = "backlog.z_implemented.";
export const Z_ARCHIVE_PREFIX = "z_archive.backlog.";
const LEGACY_ARCHIVE_PREFIX = "backlog.z_archive.";
const MD = ".md";
const GIT_TIMEOUT_MS = 120_000;

export const COHORT_KEYS = ["A", "A'", "B", "C1", "C2", "C3", "C4"];
export const FOLLOWS_CHILDREN_BY = "backlog.chore.backlog-sweep-decomposed-parent-follows-children";
export const FOLLOWS_CHILDREN_COHORT = "C4";
export const SHELVED_BY = "backlog.chore.backlog-sweep-shelve-stale-notes";
export const SHELVED_COHORT = "S";
const IN_FLIGHT_PHASES = new Set(["planned", "executing", "executed", "building"]);
const SHIPPED_PHASES = new Set(["released", "integrated"]);
const PAPER_RE = /^(?:research|roadmap)\./;
const ARCHIVED_PAPER_RE = /^z_archive\.(?:research|roadmap)\./;
const DATED_PAPER_RE = /^(?:research|roadmap)\.(\d{4})\.(\d{2})\.(\d{2})(?:\.|$)/;

// "YYYY-MM-DD" -> { date, ms } at UTC midnight; throws on anything else.
export function parseCutoff(cutoff) {
  const s = typeof cutoff === "string" ? cutoff.trim() : "";
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) throw new Error(`invalid --cutoff ${JSON.stringify(cutoff)}: expected YYYY-MM-DD`);
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (new Date(ms).toISOString().slice(0, 10) !== s) throw new Error(`invalid --cutoff ${JSON.stringify(cutoff)}: not a calendar date`);
  return { date: s, ms };
}

// A frontmatter date value as epoch milliseconds, or null when it cannot be read as one. Accepted:
// a positive integer number, an all-digit string, a Date (an unquoted YAML timestamp), and a string
// that is a strict ISO 8601 calendar date "YYYY-MM-DD" (UTC midnight, as parseCutoff) or datetime
// "YYYY-MM-DDTHH:MM[:SS[.fraction]]" ending in "Z" or a "+HH:MM"/"-HH:MM" offset. A datetime with no
// zone is rejected (its instant would depend on the machine's timezone), as is an impossible date.
const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_DATETIME_RE = /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d)(?:\.\d+)?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;

function isoStringToMs(s) {
  const m = s.match(ISO_DATE_RE) || s.match(ISO_DATETIME_RE);
  if (!m) return null;
  const ms = Date.parse(s);
  if (Number.isNaN(ms) || ms <= 0) return null;
  // The date part must round-trip (rejects e.g. 2025-02-30, which Date.UTC would roll over).
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const day = new Date(Date.UTC(y, mo - 1, d));
  if (day.getUTCFullYear() !== y || day.getUTCMonth() !== mo - 1 || day.getUTCDate() !== d) return null;
  return ms;
}

function toEpochMs(v) {
  if (typeof v === "number") return Number.isFinite(v) && Number.isInteger(v) && v > 0 ? v : null;
  if (typeof v === "string" && /^\d+$/.test(v.trim())) return Number(v.trim());
  if (v instanceof Date && !Number.isNaN(v.getTime())) return v.getTime();
  if (typeof v === "string") return isoStringToMs(v.trim());
  return null;
}

function isoDay(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

// Age of a note: `updated`, falling back to `created` when updated is absent. An unparseable value
// is not skipped over: it makes the age unreadable.
function ageOf(info) {
  const d = (info && info.data) || {};
  for (const key of ["updated", "created"]) {
    const v = d[key];
    if (v === undefined || v === null || v === "") continue;
    const ms = toEpochMs(v);
    if (ms === null) return { error: `${key} is not epoch milliseconds: ${JSON.stringify(v)}` };
    return { source: key, value: ms };
  }
  return { error: "no updated and no created" };
}

function formatAge(age) {
  return age.error ? `unreadable: ${age.error}` : `${age.source} ${age.value} (${isoDay(age.value)})`;
}

// Linear phase order for "furthest phase" of a duplicate pair, from PHASE_MACHINE.states
// (packages/mcp-rks/src/workflow/phases.mjs). `decomposed` is a terminal retirement phase with no
// place in that line, so a pair involving it is not ranked (the pair stays held).
const LINEAR_PHASES = VALID_PHASES.filter((p) => p !== "decomposed");
const TEST_REFERENCE_USES = new Set(["data", "comment"]);

export function destinationFor(filename, kind) {
  const rest = filename.replace(/^backlog\./, "");
  return kind === "z_archive" ? `${Z_ARCHIVE_PREFIX}${rest}` : `${Z_IMPL_PREFIX}${rest}`;
}

function sha256(s) {
  return crypto.createHash("sha256").update(s).digest("hex");
}

function isCandidateName(name) {
  return name.startsWith("backlog.") && !name.startsWith(Z_IMPL_PREFIX) && !name.startsWith(LEGACY_ARCHIVE_PREFIX);
}

// Top-level keys that appear more than once in a raw frontmatter block.
function duplicateTopLevelKeys(frontmatter) {
  const seen = new Set();
  const dups = new Set();
  for (const line of String(frontmatter).split("\n")) {
    const m = line.match(/^([A-Za-z0-9_$][A-Za-z0-9_$.-]*)\s*:(\s|$)/);
    if (!m) continue;
    if (seen.has(m[1])) dups.add(m[1]);
    seen.add(m[1]);
  }
  return [...dups];
}

// Read and classify one note's frontmatter. Never throws.
function readNote(notesDir, name) {
  const raw = fs.readFileSync(path.join(notesDir, name + MD), "utf8");
  const split = splitNoteFrontmatter(raw);
  const info = { name, raw, hasFrontmatter: split.frontmatter !== null, data: null, error: null, dupKeys: [] };
  if (split.frontmatter !== null) {
    info.dupKeys = duplicateTopLevelKeys(split.frontmatter);
    if (info.dupKeys.length > 0) {
      info.error = "duplicate_key";
      return info;
    }
  }
  try {
    info.data = parseFrontmatter(raw).data || {};
  } catch (err) {
    info.error = "frontmatter_unparseable";
    info.parseMessage = String(err && err.message ? err.message : err).split("\n")[0];
  }
  return info;
}

function phaseOf(info) {
  if (!info || !info.data) return undefined;
  const p = info.data.phase;
  return typeof p === "string" ? p : p === undefined || p === null ? undefined : String(p);
}

function walkFiles(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const ent of entries) {
    if (ent.name === "node_modules" || ent.name === ".git") continue;
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walkFiles(p, out);
    else if (ent.isFile()) out.push(p);
  }
  return out;
}

const SAFE_NAME_RE = /^[A-Za-z0-9_.-]+$/;
const RUN_RE = /[A-Za-z0-9_.-]+/g;

// Index of `<filename>.md` literals (and id-only mentions) under tests/, for the names given.
// A filename made only of [A-Za-z0-9_.-] can only occur inside a maximal run of those
// characters, so every substring of every run that starts at "backlog." is checked exactly.
function scanTests(projectRoot, names) {
  const fileSet = new Set(names.map((n) => n + MD));
  const idSet = new Set(names);
  const unsafe = names.filter((n) => !SAFE_NAME_RE.test(n));
  const fileRefs = new Map(); // name -> [{file, line}]
  const idRefs = new Map(); // name -> [{file, line}]
  const add = (map, name, ref) => {
    if (!map.has(name)) map.set(name, []);
    const list = map.get(name);
    const last = list[list.length - 1];
    if (!last || last.file !== ref.file || last.line !== ref.line) list.push(ref);
  };
  const testsDir = path.join(projectRoot, "tests");
  for (const abs of walkFiles(testsDir).sort()) {
    let text;
    try {
      text = fs.readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    if (!text.includes("backlog.")) continue;
    const rel = path.relative(projectRoot, abs).split(path.sep).join("/");
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line.includes("backlog.")) continue;
      for (const n of unsafe) {
        if (line.includes(n + MD)) add(fileRefs, n, { file: rel, line: i + 1 });
      }
      for (const m of line.matchAll(RUN_RE)) {
        const run = m[0];
        let s = run.indexOf("backlog.");
        while (s !== -1) {
          // filename literals: substrings [s, e+3) where run[e..e+3) === ".md"
          let e = run.indexOf(MD, s);
          while (e !== -1) {
            const cand = run.slice(s, e + MD.length);
            if (fileSet.has(cand)) add(fileRefs, cand.slice(0, -MD.length), { file: rel, line: i + 1 });
            e = run.indexOf(MD, e + 1);
          }
          // id-only mentions: substrings ending at a segment boundary, not followed by ".md"
          for (let end = s + "backlog.".length; end <= run.length; end++) {
            if (end !== run.length && run[end] !== ".") continue;
            const cand = run.slice(s, end);
            if (idSet.has(cand) && run.slice(end, end + MD.length) !== MD) add(idRefs, cand, { file: rel, line: i + 1 });
          }
          s = run.indexOf("backlog.", s + 1);
        }
      }
    }
  }
  return { fileRefs, idRefs };
}

function linesContaining(text, needle, file) {
  const refs = [];
  const lines = String(text).split("\n");
  for (let i = 0; i < lines.length; i++) if (lines[i].includes(needle)) refs.push({ file, line: i + 1 });
  return refs;
}

function resolveInside(projectRoot, rel) {
  const abs = path.resolve(projectRoot, rel);
  const relBack = path.relative(projectRoot, abs);
  if (relBack.startsWith("..") || path.isAbsolute(relBack)) return null;
  return abs;
}

function normalizeManifest(manifest) {
  const m = manifest && typeof manifest === "object" ? manifest : {};
  return {
    doneInCode: Array.isArray(m.doneInCode) ? m.doneInCode : [],
    archive: Array.isArray(m.archive) ? m.archive : [],
    held: Array.isArray(m.held) ? m.held : [],
    testReferences: Array.isArray(m.testReferences) ? m.testReferences : [],
    duplicates: Array.isArray(m.duplicates) ? m.duplicates : [],
    decomposedChildren: Array.isArray(m.decomposedChildren) ? m.decomposedChildren : [],
    decisionTestsAcceptArchive: Array.isArray(m.decisionTestsAcceptArchive) ? m.decisionTestsAcceptArchive : [],
    currentPapers: Array.isArray(m.currentPapers) ? m.currentPapers : [],
    shelve: Array.isArray(m.shelve) ? m.shelve : [],
  };
}

function readInside(projectRoot, rel) {
  const abs = typeof rel === "string" ? resolveInside(projectRoot, rel) : null;
  if (!abs) return null;
  try {
    return fs.readFileSync(abs, "utf8");
  } catch {
    return null;
  }
}

// Top-level frontmatter keys whose parsed values differ between two notes.
function differingKeys(a, b) {
  const da = (a && a.data) || {};
  const db = (b && b.data) || {};
  const keys = [...new Set([...Object.keys(da), ...Object.keys(db)])].sort();
  return keys.filter((k) => JSON.stringify(da[k]) !== JSON.stringify(db[k]));
}

// Compute the full plan: the report (returned by planSweep) and the bytes apply would write.
function computePlan({ projectRoot, manifest, fixExistingArchiveIds = false, cutoff }) {
  const cut = cutoff === undefined || cutoff === null ? null : parseCutoff(cutoff);
  const notesDir = path.join(projectRoot, "notes");
  const allNames = fs
    .readdirSync(notesDir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(MD) && !e.name.startsWith("."))
    .map((e) => e.name.slice(0, -MD.length))
    .sort();
  const nameSet = new Set(allNames);
  const m = normalizeManifest(manifest);

  // Manifest lookup; an id named by more than one entry is a conflict.
  const manifestById = new Map();
  const manifestConflicts = new Set();
  // shelve[] is consulted only with --cutoff; without one it enters only the digest.
  const lists = [["doneInCode", m.doneInCode], ["archive", m.archive], ["held", m.held]];
  if (cut) lists.push(["shelve", m.shelve]);
  for (const [list, entries] of lists) {
    for (const entry of entries) {
      if (!entry || typeof entry.id !== "string") continue;
      if (manifestById.has(entry.id)) manifestConflicts.add(entry.id);
      else manifestById.set(entry.id, { list, entry });
    }
  }

  // Parse every backlog-family note once (candidates, archived children, archived notes).
  const infos = new Map();
  for (const name of allNames) {
    if (name.startsWith("backlog.") || name.startsWith(Z_ARCHIVE_PREFIX)) infos.set(name, readNote(notesDir, name));
  }

  const candidates = allNames.filter(isCandidateName);
  const candidateSet = new Set(candidates);
  const proposals = []; // { name, cohort, kind, entry?, info, children? }
  const held = [];
  const overlaps = [];
  const hold = (name, reason, extra = {}) => held.push({ id: name, reason, reasons: [reason], phase: phaseOf(infos.get(name)), ...extra });

  const childrenOf = (name) => {
    const rest = name.replace(/^backlog\./, "");
    const prefixes = [`${name}.`, `${Z_IMPL_PREFIX}${rest}.`, `${Z_ARCHIVE_PREFIX}${rest}.`];
    return allNames.filter((n) => prefixes.some((p) => n.startsWith(p)));
  };
  const isShipped = (child) => {
    if (child.startsWith(Z_IMPL_PREFIX)) return true;
    if (child.startsWith(Z_ARCHIVE_PREFIX)) return false;
    const info = infos.get(child);
    return !!info && !info.error && phaseOf(info) === "released";
  };
  // A child id resolves at its live path, its backlog.z_implemented.* path or its z_archive.backlog.* path.
  const resolveChild = (id) => {
    if (typeof id !== "string" || id === "") return null;
    for (const n of [id, destinationFor(id, "z_implemented"), destinationFor(id, "z_archive")]) if (nameSet.has(n)) return n;
    return null;
  };
  const manifestHeldIds = new Set(m.held.filter((e) => e && typeof e.id === "string").map((e) => e.id));
  const decomposedChildrenById = new Map();
  for (const e of m.decomposedChildren) {
    if (e && typeof e.id === "string" && !decomposedChildrenById.has(e.id)) decomposedChildrenById.set(e.id, e);
  }
  // Every child of a decomposed parent: filename-prefixed children, frontmatter childStories[], and a
  // reviewed decomposedChildren[] entry. Named children that do not resolve (or, for a manifest
  // entry, are not named in the parent's own text) are unresolved and keep the parent held.
  //
  // Each child is also classified (backlog.chore.backlog-sweep-decomposed-parent-follows-children):
  // live (resolves at its live path), held (named by id in manifest held[], note or not), missing
  // (a childStories[] id that resolves nowhere and is not in held[]) and defects (a decomposedChildren[]
  // entry that lists no children, names a child absent from the parent's text, or names one that does
  // not resolve). A resolved child that is neither live nor shipped is archived.
  const childSetOf = (name, info) => {
    const children = childrenOf(name);
    const named = []; // { id, resolved, shipped, source }
    const unresolved = [];
    const missing = [];
    const defects = [];
    const heldChildren = new Set();
    const addNamed = (id, source) => {
      const resolved = resolveChild(id);
      if (manifestHeldIds.has(id)) heldChildren.add(id);
      if (resolved === null) {
        unresolved.push(`${id} (not found)`);
        if (source !== "childStories") defects.push(`${id} (not found)`);
        else if (!manifestHeldIds.has(id) && !missing.includes(id)) missing.push(id);
        return;
      }
      named.push({ id, resolved, shipped: isShipped(resolved), source });
      if (!children.includes(resolved)) children.push(resolved);
    };
    const cs = info && info.data ? info.data.childStories : undefined;
    if (Array.isArray(cs)) for (const id of cs) addNamed(id, "childStories");
    const entry = decomposedChildrenById.get(name);
    if (entry) {
      const listed = Array.isArray(entry.children) ? entry.children : [];
      if (listed.length === 0) {
        unresolved.push("(decomposedChildren entry lists no children)");
        defects.push("(decomposedChildren entry lists no children)");
      }
      for (const id of listed) {
        if (typeof id !== "string" || !info.raw.includes(id)) {
          unresolved.push(`${id} (not named in the parent note)`);
          defects.push(`${id} (not named in the parent note)`);
        } else addNamed(id, "decomposedChildren");
      }
    }
    for (const c of children) if (manifestHeldIds.has(c)) heldChildren.add(c);
    const live = children.filter((c) => !c.startsWith(Z_IMPL_PREFIX) && !c.startsWith(Z_ARCHIVE_PREFIX));
    return { children, named, unresolved, declared: Array.isArray(cs) || !!entry, live, held: [...heldChildren], missing, defects };
  };
  // C4: at least one child resolves, none is live or held, no manifest defect, and not every child shipped.
  const followsChildren = (cs) =>
    cs.children.length > 0 && cs.live.length === 0 && cs.held.length === 0 && cs.defects.length === 0 && !cs.children.every(isShipped);

  // ---- Shelved cohort S: papers, their mentions of candidate ids, and the shelving evaluation ----
  const papers = { current: [], notCurrent: [] };
  const currentPapersInvalid = [];
  const paperMentions = []; // { file, current, refs: Map(id -> [line]) }
  const ageSource = { updated: 0, created: 0 };
  if (cut) {
    const entryById = new Map();
    for (const e of m.currentPapers) {
      const id = e && typeof e.id === "string" ? e.id : null;
      let problem = null;
      if (id === null) problem = "entry has no id";
      else if (ARCHIVED_PAPER_RE.test(id) || id.startsWith("z_archive.")) problem = "a z_archive.* paper is never current";
      else if (!PAPER_RE.test(id)) problem = "not a research.* or roadmap.* note";
      else if (!nameSet.has(id)) problem = `notes/${id}${MD} does not exist`;
      else if (typeof e.reason !== "string" || e.reason.trim() === "") problem = "entry has no reason";
      if (problem) currentPapersInvalid.push({ id, detail: problem });
      else if (!entryById.has(id)) entryById.set(id, e);
    }
    const unsafe = candidates.filter((n) => !SAFE_NAME_RE.test(n));
    for (const name of allNames) {
      let current;
      let basis;
      if (ARCHIVED_PAPER_RE.test(name)) {
        current = false;
        basis = "under z_archive.* (never current)";
      } else if (PAPER_RE.test(name)) {
        const dm = name.match(DATED_PAPER_RE);
        if (dm) {
          const date = `${dm[1]}-${dm[2]}-${dm[3]}`;
          current = date >= cut.date;
          basis = `filename date ${date}`;
        } else {
          const pInfo = readNote(notesDir, name);
          const v = pInfo.data ? pInfo.data.updated : undefined;
          const ms = v === undefined || v === null ? null : toEpochMs(v);
          current = ms !== null && ms >= cut.ms;
          basis = ms === null ? "undated; updated unreadable" : `undated; updated ${ms} (${isoDay(ms)})`;
        }
        const e = entryById.get(name);
        if (e) {
          basis += `; currentPapers: ${e.reason}`;
          current = true;
        }
      } else continue;
      (current ? papers.current : papers.notCurrent).push({ id: name, basis });
      const file = `notes/${name}${MD}`;
      const text = fs.readFileSync(path.join(notesDir, name + MD), "utf8");
      const refs = new Map();
      const add = (id, line) => {
        if (!refs.has(id)) refs.set(id, []);
        const l = refs.get(id);
        if (l[l.length - 1] !== line) l.push(line);
      };
      if (text.includes("backlog.")) {
        const lines = text.split("\n");
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          if (!line.includes("backlog.")) continue;
          for (const n of unsafe) if (line.includes(n)) add(n, i + 1);
          // A candidate id is made only of [A-Za-z0-9_.-], so it occurs inside one maximal run:
          // every substring of a run that starts at "backlog." is checked (substring semantics).
          for (const mt of line.matchAll(RUN_RE)) {
            const run = mt[0];
            let st = run.indexOf("backlog.");
            while (st !== -1) {
              for (let end = st + "backlog.".length + 1; end <= run.length; end++) {
                const cand = run.slice(st, end);
                if (candidateSet.has(cand)) add(cand, i + 1);
              }
              st = run.indexOf("backlog.", st + 1);
            }
          }
        }
      }
      paperMentions.push({ file, current, refs });
    }
  }
  const paperRefsFor = (id, current) => {
    const out = [];
    for (const pm of paperMentions) {
      if (pm.current !== current || !pm.refs.has(id)) continue;
      for (const line of pm.refs.get(id)) out.push({ file: pm.file, line });
    }
    return out;
  };
  // Live children at plan start that are neither shipped nor archived: filename-prefixed children
  // and frontmatter childStories that are live candidates. A child shelved in this same run still counts.
  const liveChildrenOf = (name, info) => {
    const ids = new Set(childrenOf(name).filter((c) => candidateSet.has(c)));
    const cs = info && info.data ? info.data.childStories : undefined;
    if (Array.isArray(cs)) for (const c of cs) if (typeof c === "string" && c !== name && candidateSet.has(c)) ids.add(c);
    return [...ids].sort().filter((c) => {
      const ci = infos.get(c);
      return !(ci && !ci.error && SHIPPED_PHASES.has(phaseOf(ci)));
    });
  };
  // Everything the shelving rule needs to know about one note.
  const shelfFacts = (name, info, phase) => {
    const blockers = [];
    if (phase === "arch-approved") blockers.push({ reason: "kept_arch_approved", detail: "phase arch-approved" });
    if (info.data && Object.prototype.hasOwnProperty.call(info.data, "releasedIn")) blockers.push({ reason: "kept_released_in", detail: `releasedIn ${JSON.stringify(info.data.releasedIn)}` });
    const kids = liveChildrenOf(name, info);
    if (kids.length > 0) blockers.push({ reason: "kept_live_child", detail: `live child: ${kids.join(", ")}` });
    const age = ageOf(info);
    if (!age.error) ageSource[age.source] += 1;
    const recent = !age.error && age.value >= cut.ms;
    const currentRefs = paperRefsFor(name, true);
    return { blockers, age, recent, currentRefs };
  };

  for (const name of candidates) {
    const info = infos.get(name);
    const named = manifestById.get(name);
    if (manifestConflicts.has(name)) {
      hold(name, "manifest_conflict", { detail: "id named by more than one manifest entry" });
      continue;
    }
    if (info.error === "duplicate_key") {
      hold(name, "duplicate_key", { detail: `duplicate top-level key(s): ${info.dupKeys.join(", ")}` });
      continue;
    }
    if (info.error === "frontmatter_unparseable") {
      hold(name, "frontmatter_unparseable", { detail: info.parseMessage });
      continue;
    }
    const phase = phaseOf(info);
    if (!info.hasFrontmatter && named) {
      hold(name, "no_frontmatter", { detail: `named in manifest ${named.list}[] but the note has no frontmatter block` });
      continue;
    }

    // What the derived rules alone would select.
    let derived = null;
    let children = null;
    let childSet = null;
    if (phase === "released") derived = "A";
    else if (phase === "integrated") derived = "A'";
    else if (phase === "decomposed") {
      childSet = childSetOf(name, info);
      children = childSet.children;
      if (children.length > 0 && childSet.unresolved.length === 0 && children.every(isShipped)) derived = "C3";
      else if (followsChildren(childSet)) derived = FOLLOWS_CHILDREN_COHORT;
    }

    if (named && named.list === "held") {
      if (derived) overlaps.push({ id: name, list: "held", cohort: derived });
      hold(name, "manifest_held", { detail: String(named.entry.reason || "") });
      continue;
    }
    if (named && named.list === "shelve") {
      const e = named.entry;
      if (typeof e.reason !== "string" || e.reason.trim() === "") {
        hold(name, "invalid_manifest_entry", { detail: "shelve entry has no reason" });
        continue;
      }
      const f = shelfFacts(name, info, phase);
      const blocked = [];
      if (derived) blocked.push(`derived cohort ${derived}${phase !== undefined ? ` (phase ${phase})` : ""}`);
      for (const b of f.blockers) blocked.push(b.detail);
      if (blocked.length > 0) {
        hold(name, "shelve_entry_blocked", { detail: `shelve[] entry blocked by: ${blocked.join("; ")}` });
        continue;
      }
      const waived = [];
      if (f.recent) waived.push(`${f.age.source} on or after the cutoff`);
      for (const r of f.currentRefs) waived.push(`current paper ${r.file}:${r.line}`);
      proposals.push({ name, cohort: SHELVED_COHORT, kind: "z_archive", info, entry: e, age: f.age, waived });
      continue;
    }
    if (derived) {
      if (named) overlaps.push({ id: name, list: named.list, cohort: derived });
      const decomposedCohort = derived === "C3" || derived === FOLLOWS_CHILDREN_COHORT;
      const clearedBy = decomposedCohort && childSet.named.length > 0 ? { children: childSet.named } : undefined;
      if (derived === FOLLOWS_CHILDREN_COHORT) {
        proposals.push({ name, cohort: derived, kind: "z_archive", info, children, clearedBy, missingChildren: childSet.missing });
      } else {
        proposals.push({ name, cohort: derived, kind: "z_implemented", info, children, clearedBy });
      }
      continue;
    }
    if (named && named.list === "archive") {
      const e = named.entry;
      if (e.kind === "superseded") {
        // supersededBy is one id or a non-empty list of ids (a note split into several successors);
        // every id must resolve to a note under notes/.
        const by = Array.isArray(e.supersededBy) ? e.supersededBy : [e.supersededBy];
        if (by.length === 0 || !by.every((b) => typeof b === "string" && nameSet.has(b))) {
          hold(name, "superseder_not_found", { detail: `supersededBy ${JSON.stringify(e.supersededBy)} does not resolve to a note under notes/` });
          continue;
        }
        proposals.push({ name, cohort: "C1", kind: "z_archive", info, entry: e });
      } else if (e.kind === "wont-do") {
        if (typeof e.reason !== "string" || e.reason.trim() === "") {
          hold(name, "invalid_manifest_entry", { detail: "wont-do entry has no reason" });
          continue;
        }
        proposals.push({ name, cohort: "C2", kind: "z_archive", info, entry: e });
      } else {
        hold(name, "invalid_manifest_entry", { detail: `unknown archive kind ${JSON.stringify(e.kind)}` });
      }
      continue;
    }
    if (named && named.list === "doneInCode") {
      const evidence = Array.isArray(named.entry.evidence) ? named.entry.evidence : [];
      const missing = [];
      for (const ev of evidence) {
        const abs = ev && typeof ev.file === "string" ? resolveInside(projectRoot, ev.file) : null;
        let ok = false;
        if (abs && typeof ev.literal === "string" && ev.literal !== "") {
          try {
            ok = fs.readFileSync(abs, "utf8").includes(ev.literal);
          } catch {
            ok = false;
          }
        }
        if (!ok) missing.push(`${ev && ev.file} :: ${ev && ev.literal}`);
      }
      if (evidence.length === 0 || missing.length > 0) {
        hold(name, "evidence_not_found", { detail: evidence.length === 0 ? "no evidence listed" : `not found: ${missing.join(" | ")}` });
        continue;
      }
      proposals.push({ name, cohort: "B", kind: "z_implemented", info, entry: named.entry });
      continue;
    }
    if (phase === "decomposed") {
      if (children.length === 0 && !childSet.declared) hold(name, "no_children", { detail: "no prefixed child note on disk" });
      else {
        const unshipped = [...childSet.unresolved, ...children.filter((c) => !isShipped(c))];
        const classes = [];
        if (childSet.live.length > 0) classes.push(`live: ${childSet.live.join(", ")}`);
        if (childSet.held.length > 0) classes.push(`held: ${childSet.held.join(", ")}`);
        if (childSet.missing.length > 0) classes.push(`missing: ${childSet.missing.join(", ")}`);
        if (childSet.defects.length > 0) classes.push(`manifest defect: ${childSet.defects.join(", ")}`);
        if (children.length === 0) classes.push("no declared child resolves");
        hold(name, "children_not_shipped", {
          detail: `unshipped: ${unshipped.join(", ")}${classes.length > 0 ? `; ${classes.join("; ")}` : ""}`,
          children: { live: childSet.live, held: childSet.held, missing: childSet.missing, defects: childSet.defects },
        });
      }
      continue;
    }
    if (cut) {
      // The residue: shelved unless an exception keeps it. Primary reason first, every reason listed.
      const f = shelfFacts(name, info, phase);
      const keep = [...f.blockers];
      if (f.age.error) keep.push({ reason: "age_unreadable", detail: f.age.error });
      if (f.recent) keep.push({ reason: "kept_recent", detail: `${formatAge(f.age)} is on or after the cutoff ${cut.date}` });
      if (f.currentRefs.length > 0) keep.push({ reason: "kept_current_paper", detail: `named by a current paper` });
      if (keep.length > 0) {
        const extra = { reasons: keep.map((k) => k.reason), detail: keep.map((k) => k.detail).join("; ") };
        if (f.currentRefs.length > 0) extra.paperRefs = f.currentRefs;
        hold(name, keep[0].reason, extra);
        continue;
      }
      proposals.push({ name, cohort: SHELVED_COHORT, kind: "z_archive", info, age: f.age });
      continue;
    }
    hold(name, "user_hold", { detail: `phase ${phase === undefined ? "(none)" : phase}; not selected (user decision: hold)` });
  }

  // Manifest entries that name no live candidate note.
  for (const [id, { list }] of manifestById) {
    if (candidateSet.has(id)) continue;
    const archivedAt = [destinationFor(id, "z_implemented"), destinationFor(id, "z_archive")].filter((n) => nameSet.has(n));
    held.push({
      id,
      reason: "note_not_found",
      reasons: ["note_not_found"],
      detail: `named in manifest ${list}[] but notes/${id}${MD} does not exist${archivedAt.length ? `; archived copy: ${archivedAt.join(", ")}` : ""}`,
    });
  }

  // Guards on every proposal.
  const proposedNames = proposals.map((p) => p.name);
  const { fileRefs, idRefs } = scanTests(projectRoot, proposedNames);
  let readme = "";
  try {
    readme = fs.readFileSync(path.join(projectRoot, "README.md"), "utf8");
  } catch {
    readme = "";
  }
  const decisionFiles = allNames.filter((n) => n.startsWith("decision.")).map((n) => ({ file: `notes/${n}${MD}`, text: fs.readFileSync(path.join(notesDir, n + MD), "utf8") }));

  // A reviewed test reference covers one `<id>.md` reference when id, file and line match and the
  // line still contains the recorded text at run time.
  const testFileLines = new Map();
  const linesOf = (rel) => {
    if (!testFileLines.has(rel)) {
      const text = readInside(projectRoot, rel);
      testFileLines.set(rel, text === null ? null : text.split("\n"));
    }
    return testFileLines.get(rel);
  };
  const reviewedRef = (name, ref) => {
    for (const e of m.testReferences) {
      if (!e || e.id !== name || e.file !== ref.file || e.line !== ref.line) continue;
      if (typeof e.text !== "string" || e.text === "" || !TEST_REFERENCE_USES.has(e.use)) continue;
      const lines = linesOf(e.file);
      if (lines && typeof lines[ref.line - 1] === "string" && lines[ref.line - 1].includes(e.text)) {
        return { file: e.file, line: e.line, text: e.text, use: e.use };
      }
    }
    return null;
  };
  // A decision record accepts the z_archive path when a listed test exists and contains its literal.
  const acceptingEntry = (record) => {
    for (const e of m.decisionTestsAcceptArchive) {
      if (!e || e.record !== record || typeof e.literal !== "string" || e.literal === "") continue;
      const text = readInside(projectRoot, e.test);
      if (text !== null && text.includes(e.literal)) return { record: e.record, test: e.test, literal: e.literal };
    }
    return null;
  };
  const duplicateEntryFor = (live) => m.duplicates.find((e) => e && e.live === live);
  const pairInfo = (p, survivor) => {
    const sInfo = infos.get(survivor);
    return {
      live: p.name,
      survivor,
      identical: !!sInfo && sInfo.raw === p.info.raw,
      liveSha256: sha256(p.info.raw),
      differingKeys: sInfo ? differingKeys(p.info, sInfo) : [],
    };
  };
  // Furthest phase and releasedIn of a pair, or an error string when they cannot be combined.
  const combinePair = (liveInfo, survivorInfo) => {
    if (!survivorInfo || survivorInfo.error || !survivorInfo.data) return { error: "survivor frontmatter unreadable" };
    const lp = phaseOf(liveInfo);
    const sp = phaseOf(survivorInfo);
    let phaseKept;
    if (lp === sp) phaseKept = sp;
    else if (lp === undefined) phaseKept = sp;
    else if (sp === undefined) phaseKept = lp;
    else {
      const li = LINEAR_PHASES.indexOf(lp);
      const si = LINEAR_PHASES.indexOf(sp);
      if (li === -1 || si === -1) return { error: `phases ${JSON.stringify(lp)} and ${JSON.stringify(sp)} are not ranked` };
      phaseKept = li > si ? lp : sp;
    }
    const has = (info) => Object.prototype.hasOwnProperty.call(info.data, "releasedIn");
    const lr = has(liveInfo) ? liveInfo.data.releasedIn : undefined;
    const sr = has(survivorInfo) ? survivorInfo.data.releasedIn : undefined;
    if (lr !== undefined && sr !== undefined && JSON.stringify(lr) !== JSON.stringify(sr)) {
      return { error: `releasedIn differs: live ${JSON.stringify(lr)}, survivor ${JSON.stringify(sr)}` };
    }
    const releasedInKept = sr !== undefined ? sr : lr;
    const updates = {};
    if (phaseKept !== sp) updates.phase = phaseKept;
    if (releasedInKept !== undefined && sr === undefined) updates.releasedIn = String(releasedInKept);
    return { phaseKept, releasedInKept, updates };
  };

  const moves = [];
  const duplicatesResolved = [];
  for (const p of proposals) {
    const reasons = [];
    const extra = {};
    const clearedBy = p.clearedBy ? { ...p.clearedBy } : {};
    const to = destinationFor(p.name, p.kind);
    const existing = [destinationFor(p.name, "z_implemented"), destinationFor(p.name, "z_archive")].filter((n) => nameSet.has(n));
    let duplicate = null;
    if (existing.length > 0) {
      reasons.push("target_exists");
      extra.existing = existing;
      const survivor = destinationFor(p.name, "z_implemented");
      // A z_implemented proposal, or a shelve (cohort S) proposal, whose ONLY existing destination is
      // its backlog.z_implemented twin may resolve as a reviewed duplicate. Keyed on the S cohort, not
      // on kind z_archive, so C1/C2 proposals stay excluded
      // (backlog.chore.backlog-sweep-residual-mechanical-holds).
      const admitted = p.kind === "z_implemented" || p.cohort === SHELVED_COHORT;
      if (admitted && existing.length === 1 && existing[0] === survivor) {
        extra.pair = pairInfo(p, survivor);
        const e = duplicateEntryFor(p.name);
        if (e) {
          const combined = combinePair(p.info, infos.get(survivor));
          if (e.survivor !== survivor) extra.duplicateDetail = `duplicates[] survivor ${JSON.stringify(e.survivor)} is not ${survivor}`;
          else if (e.sha256 !== extra.pair.liveSha256) extra.duplicateDetail = `duplicates[] sha256 ${JSON.stringify(e.sha256)} does not match the live copy (${extra.pair.liveSha256})`;
          else if (combined.error) extra.duplicateDetail = `duplicates[] pair not combinable: ${combined.error}`;
          else duplicate = { survivor, combined };
        }
      }
    }
    if (fileRefs.has(p.name)) {
      const refs = fileRefs.get(p.name);
      const reviewed = refs.map((r) => reviewedRef(p.name, r));
      if (reviewed.every((r) => r !== null)) clearedBy.testReferences = reviewed;
      else {
        reasons.push("test_reference");
        extra.refs = refs;
        const unreviewed = refs.filter((r, i) => reviewed[i] === null);
        if (unreviewed.length !== refs.length) extra.unreviewedRefs = unreviewed;
      }
    }
    if (p.kind === "z_archive") {
      if (readme.includes(p.name)) {
        reasons.push("readme_reference");
        extra.readmeRefs = linesContaining(readme, p.name, "README.md");
      }
      const dRefs = decisionFiles.flatMap((d) => linesContaining(d.text, p.name, d.file));
      if (dRefs.length > 0) {
        const records = [...new Set(dRefs.map((r) => r.file.replace(/^notes\//, "").replace(/\.md$/, "")))].sort();
        const accepted = records.map((rec) => acceptingEntry(rec));
        if (accepted.every((a) => a !== null)) {
          clearedBy.decisionTestsAcceptArchive = accepted;
          clearedBy.decisionRefs = dRefs;
        } else {
          reasons.push("decision_reference");
          extra.decisionRecordsWithoutEntry = records.filter((rec, i) => accepted[i] === null);
          if (!extra.refs) extra.refs = dRefs;
          else extra.decisionRefs = dRefs;
        }
      }
      if (p.info.data && Object.prototype.hasOwnProperty.call(p.info.data, "releasedIn")) {
        reasons.push("released_in_reference");
        extra.releasedIn = p.info.data.releasedIn;
      }
    }
    // A listed duplicate pair whose only hold is target_exists is resolved instead of moved.
    if (duplicate && reasons.length === 1 && reasons[0] === "target_exists") {
      duplicatesResolved.push({
        live: p.name,
        survivor: duplicate.survivor,
        sha256: extra.pair.liveSha256,
        identical: extra.pair.identical,
        differingKeys: extra.pair.differingKeys,
        phaseKept: duplicate.combined.phaseKept,
        releasedInKept: duplicate.combined.releasedInKept,
        cohort: p.cohort,
        updates: duplicate.combined.updates,
        ...(Object.keys(clearedBy).length > 0 ? { clearedBy } : {}),
      });
      continue;
    }
    if (reasons.length > 0) {
      const details = [];
      if (extra.existing) details.push(`destination exists: ${extra.existing.join(", ")}`);
      if (extra.pair) details.push(`pair: byte-identical ${extra.pair.identical}; differing keys: ${extra.pair.differingKeys.join(", ") || "(none)"}; live sha256 ${extra.pair.liveSha256}`);
      if (extra.duplicateDetail) details.push(extra.duplicateDetail);
      if (extra.decisionRecordsWithoutEntry) details.push(`citing decision records without a decisionTestsAcceptArchive entry whose test contains its literal: ${extra.decisionRecordsWithoutEntry.join(", ")}`);
      if (extra.releasedIn !== undefined) details.push(`releasedIn: ${JSON.stringify(extra.releasedIn)}`);
      held.push({ id: p.name, reason: reasons[0], reasons, phase: phaseOf(p.info), cohort: p.cohort, to, detail: details.join("; ") || undefined, ...extra });
      continue;
    }
    moves.push({ ...p, to, clearedBy: Object.keys(clearedBy).length > 0 ? clearedBy : undefined });
  }

  const renameMap = new Map(moves.map((mv) => [mv.name, mv.to]));
  // Wikilinks and decomposedInto that name a deleted live duplicate point at its survivor.
  const dupMap = new Map(duplicatesResolved.map((d) => [d.live, d.survivor]));
  const linkMap = new Map([...renameMap, ...dupMap]);

  // Frontmatter updates per move.
  const reportMoves = [];
  const contents = new Map(); // final note name -> content (moves and rewritten notes)
  for (const mv of moves) {
    const fromPhase = phaseOf(mv.info);
    const u = { id: mv.to };
    if (mv.cohort === "A" || mv.cohort === "A'") {
      u.status = "implemented";
      u.archivedBy = ARCHIVED_BY;
      u.archiveCohort = mv.cohort === "A" ? "released" : "integrated";
    } else if (mv.cohort === "B") {
      u.status = "implemented";
      u.archivedBy = ARCHIVED_BY;
      u.archiveCohort = "done-in-code";
      if (fromPhase !== undefined) u.archivedFromPhase = fromPhase;
      u.archiveEvidence = mv.entry.evidence.map((ev) => `${ev.file} :: ${ev.literal}`);
    } else if (mv.cohort === "C1") {
      u.status = "superseded";
      u.supersededBy = mv.entry.supersededBy;
      u.archivedBy = ARCHIVED_BY;
      u.archiveCohort = "superseded";
      if (fromPhase !== undefined) u.archivedFromPhase = fromPhase;
    } else if (mv.cohort === "C2") {
      u.status = "wont-do";
      u.archiveReason = mv.entry.reason;
      u.archivedBy = ARCHIVED_BY;
      u.archiveCohort = "wont-do";
      if (fromPhase !== undefined) u.archivedFromPhase = fromPhase;
    } else if (mv.cohort === "C3") {
      u.status = "implemented";
      u.decomposedInto = mv.children.map((c) => linkMap.get(c) || c);
      u.archivedBy = ARCHIVED_BY;
      u.archiveCohort = "decomposed";
    } else if (mv.cohort === FOLLOWS_CHILDREN_COHORT) {
      const into = mv.children.map((c) => linkMap.get(c) || c);
      u.status = "superseded";
      u.supersededBy = [...into];
      u.decomposedInto = [...into];
      u.archivedBy = FOLLOWS_CHILDREN_BY;
      u.archiveCohort = "decomposed-unshipped";
      u.archivedFromPhase = "decomposed";
      if (mv.missingChildren.length > 0) u.missingChildren = [...mv.missingChildren];
    } else if (mv.cohort === SHELVED_COHORT) {
      u.status = "shelved";
      u.archivedBy = SHELVED_BY;
      u.archiveCohort = "shelved";
      if (fromPhase !== undefined) u.archivedFromPhase = fromPhase;
      u.shelvedCutoff = cut.date;
      u.shelvedAge = formatAge(mv.age);
      if (mv.entry) u.shelveReason = mv.entry.reason;
    }
    const before = {};
    for (const k of Object.keys(u)) {
      if (mv.info.data && Object.prototype.hasOwnProperty.call(mv.info.data, k)) before[k] = mv.info.data[k];
    }
    const spliced = spliceNoteFrontmatter(mv.info.raw, u);
    contents.set(mv.to, { from: mv.name, text: spliced });
    const rm = { from: mv.name, to: mv.to, cohort: mv.cohort, kind: mv.kind, fromPhase, updates: u, before };
    if (mv.clearedBy) rm.clearedBy = mv.clearedBy;
    if (mv.cohort === SHELVED_COHORT) {
      rm.age = mv.age.error ? { unreadable: mv.age.error } : { source: mv.age.source, value: mv.age.value };
      if (mv.entry) {
        rm.shelveReason = mv.entry.reason;
        rm.waived = mv.waived;
      }
      rm.namedByNotCurrent = paperRefsFor(mv.name, false);
    }
    reportMoves.push(rm);
  }

  // Survivors of resolved duplicate pairs: furthest phase and releasedIn, spliced in place.
  for (const d of duplicatesResolved) {
    if (Object.keys(d.updates).length === 0) continue;
    contents.set(d.survivor, { from: d.survivor, text: spliceNoteFrontmatter(infos.get(d.survivor).raw, d.updates) });
  }

  // Existing z_archive.backlog.* id mismatches.
  const existingArchiveIdMismatches = [];
  for (const name of allNames) {
    if (!name.startsWith(Z_ARCHIVE_PREFIX)) continue;
    const info = infos.get(name);
    if (!info || info.error || !info.data) continue;
    if (info.data.id !== name) existingArchiveIdMismatches.push({ file: name, id: info.data.id === undefined ? null : info.data.id });
  }
  const idFixes = [];
  if (fixExistingArchiveIds) {
    for (const mm of existingArchiveIdMismatches) {
      const info = infos.get(mm.file);
      const spliced = spliceNoteFrontmatter(info.raw, { id: mm.file });
      if (spliced === null) continue;
      contents.set(mm.file, { from: mm.file, text: spliced });
      idFixes.push(mm.file);
    }
  }

  // supersededBy pointers to a note shelved in this run (cohort S only) follow it to its new id.
  const supersededByRewrites = [];
  const shelvedMap = new Map(moves.filter((mv) => mv.cohort === SHELVED_COHORT).map((mv) => [mv.name, mv.to]));
  if (shelvedMap.size > 0) {
    for (const name of allNames) {
      if (dupMap.has(name)) continue;
      const finalName = renameMap.get(name) || name;
      const current = contents.has(finalName) ? contents.get(finalName).text : fs.readFileSync(path.join(notesDir, name + MD), "utf8");
      if (!current.includes("supersededBy")) continue;
      const split = splitNoteFrontmatter(current);
      if (split.frontmatter === null || duplicateTopLevelKeys(split.frontmatter).length > 0) continue;
      let data;
      try {
        data = parseFrontmatter(current).data || {};
      } catch {
        continue;
      }
      const v = data.supersededBy;
      const follow = (x) => (typeof x === "string" && x !== name && shelvedMap.has(x) ? shelvedMap.get(x) : x);
      let nv;
      if (typeof v === "string") nv = follow(v);
      else if (Array.isArray(v)) nv = v.map(follow);
      else continue;
      if (JSON.stringify(nv) === JSON.stringify(v)) continue;
      const spliced = spliceNoteFrontmatter(current, { supersededBy: nv });
      if (spliced === null) continue;
      contents.set(finalName, { from: name, text: spliced });
      supersededByRewrites.push({ note: finalName, old: v, new: nv });
    }
    supersededByRewrites.sort((a, b) => a.note.localeCompare(b.note));
  }

  // Wikilink rewrites across notes/*.md, on the post-splice text of moved notes.
  const wikilinkRewrites = [];
  let wikilinkTotal = 0;
  if (linkMap.size > 0) {
    const movedFrom = new Set(renameMap.keys());
    for (const name of allNames) {
      if (dupMap.has(name)) continue; // deleted by apply
      const finalName = renameMap.get(name) || name;
      const current = contents.has(finalName) ? contents.get(finalName).text : fs.readFileSync(path.join(notesDir, name + MD), "utf8");
      const r = rewriteWikilinks(current, linkMap);
      if (r.count === 0) continue;
      wikilinkTotal += r.count;
      wikilinkRewrites.push({ file: finalName, count: r.count, moved: movedFrom.has(name) });
      contents.set(finalName, { from: name, text: r.text });
    }
  }
  const heldIds = new Set(held.map((h) => h.id));
  const rewrittenUnmovedNotes = wikilinkRewrites.filter((w) => !w.moved).map((w) => w.file);
  const rewrittenHeldNotes = rewrittenUnmovedNotes.filter((n) => heldIds.has(n));

  // Informational: id-only mentions of moved notes under tests/.
  const testIdMentions = moves
    .filter((mv) => idRefs.has(mv.name))
    .map((mv) => ({ id: mv.name, refs: idRefs.get(mv.name) }));

  // S is a cohort key only in a --cutoff run; it is appended here and never added to the exported COHORT_KEYS.
  const cohortKeys = cut ? [...COHORT_KEYS, SHELVED_COHORT] : COHORT_KEYS;
  const counts = {
    cohorts: Object.fromEntries(cohortKeys.map((k) => [k, reportMoves.filter((mv) => mv.cohort === k).length])),
    held: {},
    moves: reportMoves.length,
    wikilinkRewrites: wikilinkTotal,
    wikilinkFiles: wikilinkRewrites.length,
    existingArchiveIdMismatches: existingArchiveIdMismatches.length,
    candidates: candidates.length,
    duplicatesResolved: duplicatesResolved.length,
  };
  for (const h of held) counts.held[h.reason] = (counts.held[h.reason] || 0) + 1;
  if (cut) {
    counts.ageSource = { ...ageSource };
    counts.supersededByRewrites = supersededByRewrites.length;
  }

  // Digest: the sorted move list and every write, by content hash.
  // The new keys enter only when non-empty, so a manifest without the reviewed lists digests as before.
  const digestInput = {
    version: 1,
    moves: [...reportMoves]
      .sort((a, b) => a.from.localeCompare(b.from))
      .map((mv) => ({ from: mv.from, to: mv.to, cohort: mv.cohort, updates: mv.updates, ...(mv.clearedBy ? { clearedBy: mv.clearedBy } : {}) })),
    writes: [...contents.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([file, c]) => ({ file, from: c.from, sha256: sha256(c.text) })),
    idFixes: [...idFixes].sort(),
  };
  if (duplicatesResolved.length > 0) {
    digestInput.duplicatesResolved = [...duplicatesResolved].sort((a, b) => a.live.localeCompare(b.live)).map((d) => ({ live: d.live, survivor: d.survivor, sha256: d.sha256, updates: d.updates }));
  }
  const reviewedLists = ["testReferences", "duplicates", "decomposedChildren", "decisionTestsAcceptArchive"];
  if (reviewedLists.some((k) => m[k].length > 0)) {
    digestInput.reviewed = Object.fromEntries(reviewedLists.map((k) => [k, m[k]]));
  }
  // backlog.chore.backlog-sweep-shelve-stale-notes: the cutoff enters only when given; the new lists
  // and the supersededBy rewrites only when non-empty, so earlier manifests digest as before.
  if (cut) digestInput.cutoff = cut.date;
  if (m.currentPapers.length > 0) digestInput.currentPapers = m.currentPapers;
  if (m.shelve.length > 0) digestInput.shelve = m.shelve;
  if (supersededByRewrites.length > 0) digestInput.supersededByRewrites = supersededByRewrites;
  const digest = sha256(JSON.stringify(digestInput));

  // shelve[] outcome per entry (cutoff runs): cohort S, or the hold reason it got.
  const shelveEntries = m.shelve.map((e) => {
    const id = e && typeof e.id === "string" ? e.id : null;
    const reason = e && typeof e.reason === "string" ? e.reason : undefined;
    if (!cut) return { id, reason, outcome: "not_consulted", detail: "shelve[] is consulted only with --cutoff" };
    const mv = reportMoves.find((x) => x.from === id);
    if (mv) return { id, reason, outcome: SHELVED_COHORT, to: mv.to, waived: mv.waived || [] };
    const h = held.find((x) => x.id === id);
    if (h) return { id, reason, outcome: h.reason, detail: h.detail };
    return { id, reason, outcome: "not_planned", detail: id === null ? "entry has no id" : "no plan entry" };
  });

  const report = {
    projectRoot,
    fixExistingArchiveIds: !!fixExistingArchiveIds,
    cutoff: cut ? cut.date : null,
    cohortKeys,
    counts,
    moves: reportMoves.sort((a, b) => a.from.localeCompare(b.from)),
    duplicatesResolved: duplicatesResolved.sort((a, b) => a.live.localeCompare(b.live)),
    held: held.sort((a, b) => a.reason.localeCompare(b.reason) || a.id.localeCompare(b.id)),
    overlaps,
    releaseCandidates: reportMoves.filter((mv) => mv.cohort === "A'").map((mv) => mv.from),
    wikilinkRewrites,
    rewrittenUnmovedNotes,
    rewrittenHeldNotes,
    existingArchiveIdMismatches,
    idFixes,
    testIdMentions,
    papers,
    currentPapersInvalid,
    keptByPaper: held.filter((h) => h.paperRefs).map((h) => ({ id: h.id, refs: h.paperRefs })),
    inFlight: reportMoves.filter((mv) => mv.cohort === SHELVED_COHORT && IN_FLIGHT_PHASES.has(mv.fromPhase)).map((mv) => ({ id: mv.from, phase: mv.fromPhase })),
    shelveEntries,
    supersededByRewrites,
    digest,
  };
  return { report, contents };
}

// Pure: reads notes/, tests/, README.md and the manifest's evidence files; writes nothing.
export function planSweep({ projectRoot, manifest, fixExistingArchiveIds = false, cutoff }) {
  return computePlan({ projectRoot, manifest, fixExistingArchiveIds, cutoff }).report;
}

function gitNotesStatus(projectRoot) {
  return execFileSync("git", ["status", "--porcelain", "--", "notes"], {
    cwd: projectRoot,
    encoding: "utf8",
    timeout: GIT_TIMEOUT_MS,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

// Refuses unless expectDigest is given, `git status --porcelain -- notes` is empty, and the
// recomputed plan's digest === expectDigest. Never overwrites a file.
export function applySweep({ projectRoot, manifest, expectDigest, fixExistingArchiveIds = false, cutoff }) {
  if (typeof expectDigest !== "string" || expectDigest.trim() === "") {
    return { ok: false, reason: "digest_required", message: "apply requires --expect <digest> from a reviewed dry run" };
  }
  if (cutoff !== undefined && cutoff !== null) {
    try {
      parseCutoff(cutoff);
    } catch (err) {
      return { ok: false, reason: "invalid_cutoff", message: err.message };
    }
  }
  let status;
  try {
    status = gitNotesStatus(projectRoot);
  } catch (err) {
    return { ok: false, reason: "git_status_failed", message: String(err && err.message ? err.message : err).split("\n")[0] };
  }
  if (status.trim() !== "") {
    return { ok: false, reason: "tree_dirty", message: "git status --porcelain -- notes is not empty", status };
  }
  const { report, contents } = computePlan({ projectRoot, manifest, fixExistingArchiveIds, cutoff });
  if (report.digest !== expectDigest.trim()) {
    return { ok: false, reason: "digest_mismatch", expected: expectDigest.trim(), actual: report.digest };
  }

  const notesDir = path.join(projectRoot, "notes");
  const errors = [];
  const movedTo = new Set(report.moves.map((mv) => mv.to));
  // Moves first: create the destination exclusively, then remove the source.
  for (const mv of report.moves) {
    const c = contents.get(mv.to);
    try {
      fs.writeFileSync(path.join(notesDir, mv.to + MD), c.text, { encoding: "utf8", flag: "wx" });
      fs.unlinkSync(path.join(notesDir, mv.from + MD));
    } catch (err) {
      errors.push({ file: mv.to, message: String(err && err.message ? err.message : err) });
    }
  }
  // Resolved duplicate pairs: delete the live copy only when its bytes still hash to the reviewed sha256.
  const duplicatesRemoved = [];
  for (const d of report.duplicatesResolved) {
    const livePath = path.join(notesDir, d.live + MD);
    try {
      const now = sha256(fs.readFileSync(livePath, "utf8"));
      if (now !== d.sha256) throw new Error(`sha256 of ${d.live} changed: ${now}`);
      fs.unlinkSync(livePath);
    } catch (err) {
      errors.push({ file: d.live, message: String(err && err.message ? err.message : err) });
    }
    duplicatesRemoved.push({ live: d.live, survivor: d.survivor, removed: !fs.existsSync(livePath) && fs.existsSync(path.join(notesDir, d.survivor + MD)) });
  }
  // Then in-place rewrites (wikilinks, supersededBy, id fixes, duplicate survivors) of notes that did not move.
  for (const [file, c] of contents) {
    if (movedTo.has(file)) continue;
    try {
      fs.writeFileSync(path.join(notesDir, file + MD), c.text, "utf8");
    } catch (err) {
      errors.push({ file, message: String(err && err.message ? err.message : err) });
    }
  }

  // Report from the filesystem, never from intent.
  const archived = report.moves.map((mv) => {
    const oldGone = !fs.existsSync(path.join(notesDir, mv.from + MD));
    const newPath = path.join(notesDir, mv.to + MD);
    const present = fs.existsSync(newPath);
    let reparsed = false;
    if (present) {
      try {
        const d = parseFrontmatter(fs.readFileSync(newPath, "utf8")).data;
        reparsed = !!d && d.id === mv.to;
      } catch {
        reparsed = false;
      }
    }
    return { from: mv.from, to: mv.to, cohort: mv.cohort, archived: oldGone && present, reparsed };
  });
  const ok = errors.length === 0 && archived.every((a) => a.archived && a.reparsed) && duplicatesRemoved.every((d) => d.removed);
  return {
    ok,
    reason: ok ? undefined : "apply_incomplete",
    digest: report.digest,
    archived,
    archivedCount: archived.filter((a) => a.archived).length,
    duplicatesRemoved,
    wikilinkRewriteCount: report.counts.wikilinkRewrites,
    supersededByRewriteCount: report.supersededByRewrites.length,
    idFixes: report.idFixes,
    errors,
  };
}

function fmtValue(v) {
  return JSON.stringify(v);
}

function formatClearedBy(p, clearedBy) {
  if (!clearedBy) return;
  for (const r of clearedBy.testReferences || []) p(`    cleared test_reference: ${r.file}:${r.line} (${r.use}) contains ${fmtValue(r.text)}`);
  for (const c of clearedBy.children || []) p(`    child (${c.source}): ${c.id} -> ${c.resolved}, shipped ${c.shipped}`);
  for (const r of clearedBy.decisionRefs || []) p(`    decision ref ${r.file}:${r.line}`);
  for (const e of clearedBy.decisionTestsAcceptArchive || []) p(`    cleared decision_reference: ${e.record} accepted by ${e.test} containing ${fmtValue(e.literal)}`);
}

export function formatReport(plan) {
  const out = [];
  const p = (s = "") => out.push(s);
  p("backlog-archive-sweep: DRY RUN (nothing written)");
  p(`projectRoot: ${plan.projectRoot}`);
  p(`fixExistingArchiveIds: ${plan.fixExistingArchiveIds}`);
  p(`candidates (notes/backlog.* not under backlog.z_implemented.*): ${plan.counts.candidates}`);
  const keys = plan.cohortKeys || COHORT_KEYS;
  p(plan.cutoff ? `cutoff: ${plan.cutoff} (shelved cohort S enabled)` : "cutoff: (none; the shelving rule is off)");
  p();
  p("== Counts per cohort ==");
  for (const k of keys) p(`  ${k.padEnd(3)} ${plan.counts.cohorts[k]}`);
  p(`  total moves ${plan.counts.moves}`);
  p(`  duplicates resolved (not moves; no cohort) ${plan.counts.duplicatesResolved}`);
  p();
  p("== Counts per held reason ==");
  for (const [k, v] of Object.entries(plan.counts.held).sort()) p(`  ${k}: ${v}`);
  if (plan.counts.ageSource) p(`  age source: updated ${plan.counts.ageSource.updated}, created ${plan.counts.ageSource.created} (notes evaluated by the shelving rule with a readable age)`);
  p();
  for (const k of keys) {
    const list = plan.moves.filter((mv) => mv.cohort === k);
    p(`== Moves: cohort ${k} (${list.length}) ==`);
    for (const mv of list) {
      p(`notes/${mv.from}${MD} -> notes/${mv.to}${MD}  (phase ${mv.fromPhase === undefined ? "(none)" : mv.fromPhase}, unchanged)`);
      for (const [key, val] of Object.entries(mv.updates)) {
        const had = Object.prototype.hasOwnProperty.call(mv.before, key);
        p(`    ${key}: ${had ? fmtValue(mv.before[key]) : "(absent)"} -> ${fmtValue(val)}`);
      }
      if (mv.cohort === SHELVED_COHORT) {
        p(`    age: ${mv.age.unreadable ? `unreadable (${mv.age.unreadable})` : `${mv.age.source} ${mv.age.value} (${isoDay(mv.age.value)})`}`);
        if (mv.shelveReason !== undefined) {
          p(`    shelve[] entry: ${fmtValue(mv.shelveReason)}`);
          for (const w of mv.waived || []) p(`    waived: ${w}`);
        }
        for (const r of mv.namedByNotCurrent || []) p(`    also named by a paper not counted current: ${r.file}:${r.line}`);
      }
      formatClearedBy(p, mv.clearedBy);
    }
    p();
  }
  p(`== Duplicates resolved: live copy deleted, survivor kept (${plan.duplicatesResolved.length}) ==`);
  for (const d of plan.duplicatesResolved) {
    p(`notes/${d.live}${MD} (deleted) == notes/${d.survivor}${MD} (survivor)  would have been cohort ${d.cohort}`);
    p(`    sha256 of live copy: ${d.sha256}`);
    p(`    byte-identical: ${d.identical}; differing keys: ${d.differingKeys.join(", ") || "(none)"}`);
    p(`    survivor keeps phase ${fmtValue(d.phaseKept)}, releasedIn ${d.releasedInKept === undefined ? "(none)" : fmtValue(d.releasedInKept)}`);
    for (const [key, val] of Object.entries(d.updates)) p(`    survivor ${key} -> ${fmtValue(val)}`);
    formatClearedBy(p, d.clearedBy);
  }
  p();
  p(`== Release candidates: cohort A' (integrated) notes the next rks_release will release (${plan.releaseCandidates.length}) ==`);
  for (const id of plan.releaseCandidates) p(`  ${id}`);
  p();
  p(`== Manifest overlaps (derived cohort or manifest hold took precedence) (${plan.overlaps.length}) ==`);
  for (const o of plan.overlaps) p(`  ${o.id}: named in ${o.list}[], derived cohort ${o.cohort}`);
  p();
  const nonUser = plan.held.filter((h) => h.reason !== "user_hold");
  p(`== Held, with reason (${nonUser.length}) ==`);
  for (const h of nonUser) {
    p(`  ${h.id}  [${h.reasons.join(", ")}]${h.phase !== undefined ? `  phase ${h.phase}` : ""}${h.cohort ? `  would be cohort ${h.cohort} -> ${h.to}` : ""}`);
    if (h.detail) p(`      ${h.detail}`);
    for (const r of h.refs || []) p(`      ref ${r.file}:${r.line}`);
    for (const r of h.unreviewedRefs || []) p(`      unreviewed ref ${r.file}:${r.line}`);
    for (const r of h.decisionRefs || []) p(`      decision ref ${r.file}:${r.line}`);
    for (const r of h.readmeRefs || []) p(`      readme ref ${r.file}:${r.line}`);
    for (const r of h.paperRefs || []) p(`      current paper ref ${r.file}:${r.line}`);
  }
  p();
  if (plan.cutoff) {
    p(`== Papers counted current (${plan.papers.current.length}) ==`);
    for (const x of plan.papers.current) p(`  ${x.id}  (${x.basis})`);
    p();
    p(`== Papers not counted current (${plan.papers.notCurrent.length}) ==`);
    for (const x of plan.papers.notCurrent) p(`  ${x.id}  (${x.basis})`);
    p();
    p(`== Invalid currentPapers entries (${plan.currentPapersInvalid.length}) ==`);
    for (const x of plan.currentPapersInvalid) p(`  ${x.id}: ${x.detail}`);
    p();
    p(`== Notes kept by a current paper (${plan.keptByPaper.length}) ==`);
    for (const k of plan.keptByPaper) p(`  ${k.id}: ${k.refs.map((r) => `${r.file}:${r.line}`).join(", ")}`);
    p();
    const byPh = {};
    for (const h of plan.inFlight) byPh[h.phase] = (byPh[h.phase] || 0) + 1;
    p(`== In-flight notes shelved after the done-in-code check (${plan.inFlight.length}): old notes at planned, executing, executed or building with no other exception ==`);
    for (const [k, v] of Object.entries(byPh).sort()) p(`  phase ${k}: ${v}`);
    for (const h of plan.inFlight) p(`  ${h.id}  (phase ${h.phase})`);
    p();
    p(`== shelve[] entries (${plan.shelveEntries.length}) ==`);
    for (const e of plan.shelveEntries) {
      p(`  ${e.id}: ${e.outcome === SHELVED_COHORT ? `cohort S -> ${e.to}` : e.outcome}  reason ${fmtValue(e.reason)}`);
      for (const w of e.waived || []) p(`      waived: ${w}`);
      if (e.detail) p(`      ${e.detail}`);
    }
    p();
    p(`== supersededBy rewrites (${plan.supersededByRewrites.length}) ==`);
    for (const r of plan.supersededByRewrites) p(`  notes/${r.note}${MD}: ${fmtValue(r.old)} -> ${fmtValue(r.new)}`);
    p();
  }
  const userHeld = plan.held.filter((h) => h.reason === "user_hold");
  const byPhase = {};
  for (const h of userHeld) {
    const k = h.phase === undefined ? "(none)" : h.phase;
    byPhase[k] = (byPhase[k] || 0) + 1;
  }
  p(`== Held by user decision (user_hold): not selected by A, A', C3 or the manifest (${userHeld.length}) ==`);
  for (const [k, v] of Object.entries(byPhase).sort()) p(`  phase ${k}: ${v}`);
  for (const h of userHeld) p(`  ${h.id}  (phase ${h.phase === undefined ? "(none)" : h.phase})`);
  p();
  p(`== Wikilink rewrites: ${plan.counts.wikilinkRewrites} link(s) in ${plan.counts.wikilinkFiles} file(s) (count from rewriteWikilinks) ==`);
  for (const w of plan.wikilinkRewrites) p(`  notes/${w.file}${MD}: ${w.count}${w.moved ? "  (moved note)" : ""}`);
  p();
  p(`== Notes that do NOT move but are edited by wikilink rewrites (${plan.rewrittenUnmovedNotes.length}; held backlog notes among them: ${plan.rewrittenHeldNotes.length}) ==`);
  const heldSet = new Set(plan.rewrittenHeldNotes);
  for (const n of plan.rewrittenUnmovedNotes) p(`  ${n}${heldSet.has(n) ? "  (held)" : ""}`);
  p();
  p(`== Existing z_archive.backlog.* id mismatches (${plan.existingArchiveIdMismatches.length}; rewritten only with --fix-existing-archive-ids) ==`);
  for (const mm of plan.existingArchiveIdMismatches) p(`  ${mm.file}  id: ${fmtValue(mm.id)}${plan.idFixes.includes(mm.file) ? "  -> fixed in this plan" : ""}`);
  p();
  p(`== Informational: moved notes named by id only (no .md) under tests/ (${plan.testIdMentions.length}); these do not hold ==`);
  for (const t of plan.testIdMentions) p(`  ${t.id}: ${t.refs.map((r) => `${r.file}:${r.line}`).join(", ")}`);
  p();
  p(`digest: ${plan.digest}`);
  p(`apply with: node scripts/backlog-archive-sweep.mjs --apply${plan.cutoff ? ` --cutoff ${plan.cutoff}` : ""} --expect ${plan.digest}${plan.fixExistingArchiveIds ? " --fix-existing-archive-ids" : ""}`);
  return out.join("\n") + "\n";
}

function parseArgs(argv) {
  const args = { apply: false, expect: undefined, json: undefined, fixExistingArchiveIds: false, manifest: undefined, cutoff: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") args.apply = true;
    else if (a === "--expect") args.expect = argv[++i];
    else if (a === "--json") args.json = argv[++i];
    else if (a === "--fix-existing-archive-ids") args.fixExistingArchiveIds = true;
    else if (a === "--manifest") args.manifest = argv[++i];
    else if (a === "--cutoff") args.cutoff = argv[++i];
    else throw new Error(`unknown argument: ${a}`);
  }
  if (args.cutoff !== undefined) parseCutoff(args.cutoff);
  return args;
}

// The CLI sets process.exitCode instead of calling process.exit(): exiting immediately after a
// large stdout write to a pipe truncates the report.
function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    return 2;
  }
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const manifestPath = args.manifest ? path.resolve(args.manifest) : path.join(projectRoot, "scripts/backlog-archive-manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (!args.apply) {
    const plan = planSweep({ projectRoot, manifest, fixExistingArchiveIds: args.fixExistingArchiveIds, cutoff: args.cutoff });
    process.stdout.write(formatReport(plan));
    if (args.json) fs.writeFileSync(path.resolve(args.json), JSON.stringify(plan, null, 2) + "\n", "utf8");
    return 0;
  }
  const result = applySweep({ projectRoot, manifest, expectDigest: args.expect, fixExistingArchiveIds: args.fixExistingArchiveIds, cutoff: args.cutoff });
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  return result.ok ? 0 : 1;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) process.exitCode = main(process.argv.slice(2));
