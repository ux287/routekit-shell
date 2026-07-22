import fs from "fs";
import path from "path";
import os from "os";
import YAML from "yaml";
import { retrieveWithRouting as _retrieveWithRouting } from "../../../../src/router.js";

const CONTEXT_ROOTS = ["notes", "src", "docs"];
const MAX_FILE_KB = 256;
const PLANNER_IMPL = "stub-v1";
const DEFAULT_K = 5;
const MAX_SNIPPET_CHARS = 160;
const DEFAULT_FINDINGS_MAX = 5;

/**
 * @typedef {Object} PlanRunState
 * @property {number} version
 * @property {string} createdAt
 * @property {string} label
 * @property {string} slug
 * @property {{type: "file"|"stdin"|"none", path: string|null}} problemSource
 * @property {{problemText: string, contextSpec: {fsRoots: string[], maxFileKB: number}}} inputs
 * @property {{draftPath: string, notesPath: string|null}} outputs
 * @property {{kRequested: number, trace: any[], passages: any[], errors: Array<{code: string, message: string, details?: Record<string, any>}>}} retrieval
 * @property {{repo: string, tool: string, plannerImpl: string}} provenance
 */

class PlanError extends Error {
  constructor(message, exitCode = 1, details = null) {
    super(message);
    this.name = "PlanError";
    this.exitCode = exitCode;
    this.details = details;
  }
}

export async function runPlanner(options) {
  const {
    shellRoot,
    cwd = process.cwd(),
    label: providedLabel = null,
    problemArg = null,
    stdinText = null,
    apply = false,
    yes = false,
    outPath = null,
    k: requestedK = null,
    projectId = null,
  } = options;

  if (!shellRoot) throw new PlanError("Missing shell root for planner context", 2);
  const createdAt = new Date().toISOString();
  const runStamp = createdAt.replace(/:/g, "-");
  const k = normalizeK(requestedK);

  const problemInfo = resolveProblemInput({ problemArg, cwd, stdinText });
  const label = deriveLabel({ providedLabel, problemInfo });
  const slug = sanitizeSlug(label);
  const runFolderName = `${runStamp}_${slug}`;
  const runFolder = path.join(shellRoot, "runs", runFolderName);
  ensureDir(runFolder);

  const outputPath = path.join(runFolder, "output.md");
  const statePath = path.join(runFolder, "state.json");
  const relativeRunFolder = path.relative(shellRoot, runFolder) || ".";

  const frontmatter = buildFrontmatter({
    createdAt,
    label,
    slug,
    projectId: options.projectId || null,
    problemInfo,
    runFolder: relativeRunFolder,
  });
  const retrieval = await performRetrieval({
    shellRoot,
    query: buildRetrievalQuery({ problemInfo, label }),
    k,
    projectId: projectId || null,
  });
  if (retrieval.errors.length > 0) {
    const warning = retrieval.errors.map(err => err.message).join("; ");
    console.warn(`[routekit plan] retrieval degraded: ${warning}`);
  }

  const topPassages = selectTopPassages(retrieval.passages || [], DEFAULT_FINDINGS_MAX);
  const findingsSection = buildFindingsSection(topPassages, retrieval.errors || []);
  const actionsSection = buildActionsSection(topPassages, retrieval.errors || []);
  const draftBody = buildDraftBody({ problemInfo, findingsSection, actionsSection });
  const sourcesSection = buildSourcesSection(retrieval);
  const draftContent = [frontmatter, draftBody, sourcesSection].filter(Boolean).join("\n");

  fs.writeFileSync(outputPath, draftContent);

  let notesPath = null;
  if (apply) {
    notesPath = path.join(shellRoot, "notes", `drafts.plan.${slug}.md`);
    ensureDir(path.dirname(notesPath));
    if (fs.existsSync(notesPath) && !yes) {
      throw new PlanError(
        `notes/drafts.plan.${slug}.md already exists. Re-run with --yes to overwrite.`,
        3,
        { notesPath }
      );
    }
    fs.writeFileSync(notesPath, draftContent);
  }

  const extraOutputPath = handleOutPath({
    outPath,
    shellRoot,
    draftContent,
    outputPath,
    notesPath,
    apply,
  });

  const state = buildState({
    createdAt,
    label,
    slug,
    projectId: projectId || null,
    problemInfo,
    runFolder: relativeRunFolder,
    outputPath,
    notesPath,
    shellRoot,
    retrieval,
  });
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));

  appendRegistryEntry(shellRoot, {
    timestamp: createdAt,
    label,
    slug,
    projectId: options.projectId || null,
    runFolder: relativeRunFolder,
    state: path.relative(shellRoot, statePath),
    output: path.relative(shellRoot, outputPath),
    source: problemInfo.path || problemInfo.type || "unknown",
  });

  const planPath = path.join(runFolder, "plan.yaml");
  const planObj = buildPlanYaml(state, topPassages, problemInfo);
  fs.writeFileSync(planPath, YAML.stringify(planObj), "utf8");

  return {
    ok: true,
    runFolder,
    files: {
      state: statePath,
      output: outputPath,
      notes: notesPath,
      extra: extraOutputPath,
      plan: planPath,
    },
  };
}

function resolveProblemInput({ problemArg, cwd, stdinText }) {
  if (!problemArg) {
    return {
      type: "none",
      path: null,
      text: "",
    };
  }
  if (problemArg === "-") {
    const text = typeof stdinText === "string" ? stdinText : "";
    return {
      type: "stdin",
      path: null,
      text,
    };
  }
  const absPath = path.resolve(cwd, problemArg);
  if (!fs.existsSync(absPath)) {
    throw new PlanError(`Problem file not found: ${problemArg}`, 2);
  }
  const stat = fs.statSync(absPath);
  if (!stat.isFile()) {
    throw new PlanError(`Problem input must be a file: ${problemArg}`, 2);
  }
  const text = fs.readFileSync(absPath, "utf8");
  return {
    type: "file",
    path: absPath,
    text: text || "",
  };
}

function deriveLabel({ providedLabel, problemInfo }) {
  if (providedLabel && providedLabel.trim()) return providedLabel.trim();
  if (problemInfo.type === "file" && problemInfo.path) {
    const name = path.basename(problemInfo.path).replace(/\.[^.]+$/, "");
    if (name) return name;
  }
  if (problemInfo.text && problemInfo.text.trim()) {
    const seed = problemInfo.text.trim().split(/\s+/).slice(0, 4).join(" ");
    if (seed) return seed;
  }
  return "unlabeled";
}

function sanitizeSlug(value) {
  const cleaned = (value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return cleaned || "unlabeled";
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function buildFrontmatter({ createdAt, label, slug, problemInfo, runFolder, projectId }) {
  const lines = [
    "---",
    `version: 1`,
    `createdAt: ${createdAt}`,
    `label: ${label}`,
    `slug: ${slug}`,
    `projectId: ${projectId ?? "null"}`,
    `source: ${problemInfo.type}`,
  ];
  if (problemInfo.path) {
    lines.push(`sourcePath: ${problemInfo.path}`);
  }
  lines.push(`runFolder: ${runFolder}`);
  lines.push("---");
  return lines.join("\n");
}

function buildDraftBody({ problemInfo, findingsSection, actionsSection }) {
  const contextBullets = [
    `- Planner stub: ${PLANNER_IMPL}`,
    `- Problem source: ${describeProblemSource(problemInfo)}`,
    `- Planned context roots: ${CONTEXT_ROOTS.join(", ")}`,
    `- Max file size (KB): ${MAX_FILE_KB}`,
  ];

  if (problemInfo.text && problemInfo.text.trim()) {
    const excerpt = problemInfo.text.trim().split(/\n+/)[0].slice(0, 140);
    contextBullets.push(`- Problem excerpt: ${excerpt}`);
  }

  return [
    "## Context",
    contextBullets.map(b => `${b}`).join("\n"),
    "",
    "## Findings",
    findingsSection || "- No findings available.",
    "",
    "## Actions",
    actionsSection || "- [ ] Review retrieved context when RAG integration is ready.",
    "",
    "## Open Questions",
    "- Which documents should seed the planner first?",
    "- What approval path governs apply mode for this plan?",
    "",
    "## Next Steps",
    "1. Integrate RAG + Dendron retrieval into this planner.",
    "2. Replace stub outputs with grounded findings and actions.",
  ].join("\n");
}

function describeProblemSource(info) {
  if (info.type === "file") return info.path ? `file (${info.path})` : "file";
  if (info.type === "stdin") {
    return info.text && info.text.trim() ? "stdin" : "stdin (empty)";
  }
  return "none";
}

function handleOutPath({ outPath, shellRoot, draftContent, outputPath, notesPath, apply }) {
  if (!outPath) return null;
  const resolved = path.resolve(outPath);
  if (!isInside(shellRoot, resolved)) {
    throw new PlanError(`--out path must stay inside the repo: ${outPath}`, 2);
  }
  const notesDir = path.join(shellRoot, "notes");
  const inNotes = isInside(notesDir, resolved);
  const matchesOutput = resolved === outputPath;
  const _matchesNotes = notesPath && resolved === notesPath;
  if (matchesOutput) return null;
  if (apply && inNotes) return null;
  ensureDir(path.dirname(resolved));
  fs.writeFileSync(resolved, draftContent);
  return resolved;
}

function isInside(base, target) {
  const rel = path.relative(base, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** @returns {PlanRunState} */
function buildState({ createdAt, label, slug, problemInfo, runFolder, outputPath, notesPath, shellRoot, retrieval, projectId }) {
  return {
    version: 1,
    createdAt,
    label,
    slug,
    projectId: projectId ?? null,
    problemSource: {
      type: problemInfo.type,
      path: problemInfo.path || null,
    },
    inputs: {
      problemText: problemInfo.text || "",
      contextSpec: {
        fsRoots: CONTEXT_ROOTS,
        maxFileKB: MAX_FILE_KB,
      },
    },
    outputs: {
      draftPath: path.join(runFolder, path.basename(outputPath)),
      notesPath: notesPath ? path.relative(shellRoot, notesPath) : null,
    },
    retrieval,
    provenance: {
      repo: shellRoot,
      tool: "routekit plan",
      plannerImpl: PLANNER_IMPL,
    },
  };
}

function normalizeK(value) {
  if (!Number.isFinite(value)) return DEFAULT_K;
  return Math.max(1, Math.floor(value));
}

function buildRetrievalQuery({ problemInfo, label }) {
  if (problemInfo.text && problemInfo.text.trim()) return problemInfo.text.trim();
  if (label && label.trim()) return label.trim();
  return "routekit plan";
}

async function performRetrieval({ shellRoot, query, k, projectId = null }) {
  const routerPath = path.join(shellRoot, ".routekit", "retrieval.router.yaml");
  const guardrailPath = path.join(shellRoot, ".routekit", "policy.guardrails.yaml");
  const slug = path.basename(shellRoot);
  const rksRagDbPath = path.join(os.homedir(), "Documents", "projects", ".routekit", "rag", `${slug}.lancedb`);
  let ragDbPath = rksRagDbPath;
  let ragSource = "rks-rag";
  let searchDirs = [];
  let projectError = null;
  if (projectId) {
    try {
      const { getProjectById, getProjectRagRoot, getProjectSearchDirs } = await import("../project/index.js");
      const project = getProjectById(projectId, shellRoot);
      if (!project) {
        projectError = `Project not found: ${projectId}`;
      } else {
        const projDirs = getProjectSearchDirs(project);
        searchDirs = [...projDirs];
        const candidateProjectRag = getProjectRagRoot(project);
        if (fs.existsSync(candidateProjectRag)) {
          ragDbPath = candidateProjectRag;
          ragSource = "project-rag";
        }
      }
    } catch (err) {
      projectError = err?.message || String(err);
    }
  }
  const fallbackDirs = CONTEXT_ROOTS.map((dir) => path.join(shellRoot, dir)).filter((dir) => fs.existsSync(dir));
  if (fallbackDirs.length) {
    const merged = [...searchDirs, ...fallbackDirs];
    const seen = new Set();
    searchDirs = merged.filter((dir) => {
      if (seen.has(dir)) return false;
      seen.add(dir);
      return fs.existsSync(dir);
    });
  }
  const retrieval = {
    kRequested: k,
    trace: [],
    passages: [],
    errors: [],
  };

  const missing = [];
  if (!fs.existsSync(routerPath)) missing.push(routerPath);
  if (!fs.existsSync(guardrailPath)) missing.push(guardrailPath);
  if (!fs.existsSync(ragDbPath)) missing.push(ragDbPath);

  if (missing.length > 0) {
    retrieval.errors.push({
      code: "RAG_CONFIG_MISSING",
      message: "RAG configuration or DB not found; planner ran in degraded mode.",
      details: { missing },
    });
    if (projectError) {
      retrieval.errors.push({ code: "PROJECT_LOOKUP_FAILED", message: projectError });
    }
    return retrieval;
  }

  const restoreEnv = silenceRagLogs();
  try {
    const routerConfig = YAML.parse(fs.readFileSync(routerPath, "utf8"));
    const guardrailConfig = YAML.parse(fs.readFileSync(guardrailPath, "utf8"));
    const { retrieveWithRouting } = await import("../../../../src/router.js");
    const result = await withSuppressedConsole(() =>
      retrieveWithRouting(query, routerConfig, guardrailConfig, {
        searchDirs: searchDirs.length ? searchDirs : undefined,
        ragDbPath,
        ragSource,
        projectSlug: projectId || null,
      })
    );
    const normalized = (result.passages || [])
      .slice(0, k)
      .map((p) => normalizePassage(p));
    retrieval.passages = normalized;
    retrieval.trace = Array.isArray(result.trace) ? result.trace : [];
    if (projectError) {
      retrieval.errors.push({ code: "PROJECT_LOOKUP_FAILED", message: projectError });
    }
    if (Array.isArray(result.errors) && result.errors.length > 0) {
      retrieval.errors.push(...result.errors);
    }
    return retrieval;
  } catch (error) {
    retrieval.errors.push({
      code: "RETRIEVAL_ERROR",
      message: error instanceof Error ? error.message : String(error),
    });
    return retrieval;
  } finally {
    restoreEnv();
  }
}

function normalizePassage(passage) {
  const pathValue = passage.path || "unknown";
  const lineStart = Number.isFinite(passage.line_start) ? passage.line_start : null;
  const lineEnd = Number.isFinite(passage.line_end) ? passage.line_end : null;
  const snippet = (passage.text || "").replace(/\s+/g, " ").trim();
  return {
    source: passage.source || "unknown",
    path: pathValue,
    line_start: lineStart,
    line_end: lineEnd,
    text: snippet,
    score: typeof passage.score === "number" ? Number(passage.score) : null,
  };
}

function buildSourcesSection(retrieval) {
  const header = "## Sources";
  if (!retrieval) {
    return `${header}\n\n- Retrieval data unavailable.`;
  }
  const valid = (retrieval.passages || []).filter(isRenderablePassage);
  if (valid.length === 0) {
    return `${header}\n\n- Retrieval is currently degraded or returned no sources.`;
  }
  const sorted = valid.sort((a, b) => {
    const pathA = a.path || "";
    const pathB = b.path || "";
    if (pathA === pathB) {
      return (a.line_start ?? 0) - (b.line_start ?? 0);
    }
    return pathA.localeCompare(pathB);
  });
  const bullets = sorted.map((passage) => {
    const range = formatRange(passage.line_start, passage.line_end);
    const snippet = formatSnippet(passage.text);
    return `- \`${passage.path}:${range}\` – ${snippet}`;
  });
  return `${header}\n\n${bullets.join("\n")}`;
}

function formatSnippet(text) {
  const clean = (text || "").replace(/\s+/g, " ").trim();
  if (clean.length <= MAX_SNIPPET_CHARS) return clean || "(empty snippet)";
  return `${clean.slice(0, MAX_SNIPPET_CHARS - 1)}…`;
}

export function formatRange(start, end) {
  if (typeof start !== "number" || start <= 0) return "?";
  if (typeof end !== "number" || end <= 0 || end === start) return `${start}`;
  return `${start}-${end}`;
}

async function withSuppressedConsole(fn) {
  const originalLog = console.log;
  console.log = () => {};
  try {
    return await fn();
  } finally {
    console.log = originalLog;
  }
}

function silenceRagLogs() {
  const previous = process.env.ROUTEKIT_SILENCE_RAG_LOGS;
  process.env.ROUTEKIT_SILENCE_RAG_LOGS = "1";
  return () => {
    if (previous === undefined) {
      delete process.env.ROUTEKIT_SILENCE_RAG_LOGS;
    } else {
      process.env.ROUTEKIT_SILENCE_RAG_LOGS = previous;
    }
  };
}

export function isRenderablePassage(passage) {
  if (!passage) return false;
  if (typeof passage.path !== "string" || passage.path.trim() === "") return false;
  if (typeof passage.text !== "string" || passage.text.trim() === "") return false;
  if (passage.path.trim() === "--") return false;
  return true;
}

export function listRuns(shellRoot, projectId = null) {
  // Scan .rks/runs/ directory for run.json files
  const runsDir = path.join(shellRoot, ".rks", "runs");
  if (!fs.existsSync(runsDir)) {
    return { entries: [], text: "No runs found." };
  }

  const entries = [];
  const subdirs = fs.readdirSync(runsDir, { withFileTypes: true });
  for (const dirent of subdirs) {
    if (!dirent.isDirectory()) continue;
    const runJsonPath = path.join(runsDir, dirent.name, "run.json");
    if (!fs.existsSync(runJsonPath)) continue;
    try {
      const data = JSON.parse(fs.readFileSync(runJsonPath, "utf8"));
      entries.push({
        ...data,
        runFolder: path.join(runsDir, dirent.name),
        timestamp: data.timestamp || dirent.name.split("_")[0],
      });
    } catch {
      // skip malformed run.json
    }
  }

  const filtered = projectId ? entries.filter((e) => (e.projectId || null) === projectId) : entries;

  filtered.sort((a, b) => (b.timestamp || "").localeCompare(a.timestamp || ""));
  if (filtered.length === 0) {
    if (projectId) return { entries: [], text: `No runs found for project ${projectId}.` };
    return { entries: [], text: "No runs found." };
  }

  const rows = filtered.map((e) => {
    const ts = e.timestamp || "?";
    const lbl = e.label || e.slug || "?";
    const slugVal = e.slug || "?";
    const folder = e.runFolder || e.folder || "?";
    return `${ts.padEnd(27)}  ${lbl.padEnd(14)}  ${slugVal.padEnd(14)}  ${folder}`;
  });
  const header = "TIMESTAMP                   LABEL          SLUG            FOLDER";
  return { entries: filtered, text: [header, ...rows].join("\n") };
}

function readRunRegistry(shellRoot) {
  const indexPath = path.join(shellRoot, "runs", "index.jsonl");
  if (!fs.existsSync(indexPath)) return [];
  return fs
    .readFileSync(indexPath, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

export function getLatestRunForProjectLabel(shellRoot, projectId, label) {
  if (!projectId || !label) return null;
  const entries = readRunRegistry(shellRoot);
  const filtered = entries.filter(
    (e) => (e.projectId || null) === projectId && (e.label || "") === label
  );
  if (filtered.length === 0) return null;
  filtered.sort((a, b) => (b.timestamp || "").localeCompare(a.timestamp || ""));
  return filtered[0];
}

function appendRegistryEntry(shellRoot, entry) {
  try {
    const runsDir = path.join(shellRoot, "runs");
    ensureDir(runsDir);
    const indexPath = path.join(runsDir, "index.jsonl");
    fs.appendFileSync(indexPath, JSON.stringify(entry) + "\n");
  } catch (error) {
    console.warn(`[routekit plan] warning: failed to update run registry: ${error.message || error}`);
  }
}

export function loadPlanYaml(runFolder, shellRoot) {
  const base = path.isAbsolute(runFolder) ? runFolder : path.join(shellRoot, runFolder);
  const planPath = path.join(base, "plan.yaml");
  if (!fs.existsSync(planPath)) return null;
  try {
    const parsed = YAML.parse(fs.readFileSync(planPath, "utf8"));
    return { plan: parsed, planPath };
  } catch (error) {
    throw new PlanError(`Failed to parse plan.yaml in ${base}: ${error.message || error}`, 1, {
      planPath,
    });
  }
}

export function selectTopPassages(passages, maxCount = DEFAULT_FINDINGS_MAX) {
  if (!Array.isArray(passages) || passages.length === 0) return [];
  const sortable = passages.map((p) => ({
    ...p,
    _score: typeof p.score === "number" ? p.score : -Infinity,
  }));
  sortable.sort((a, b) => {
    if (b._score !== a._score) return b._score - a._score;
    const pathA = a.path || "";
    const pathB = b.path || "";
    if (pathA === pathB) {
      return (a.line_start ?? 0) - (b.line_start ?? 0);
    }
    return pathA.localeCompare(pathB);
  });
  return sortable.slice(0, maxCount).map(({ _score, ...rest }) => rest);
}

export function buildFindingsSection(passages, errors = []) {
  const unique = dedupePassages(passages);
  if (!Array.isArray(unique) || unique.length === 0) {
    if (Array.isArray(errors) && errors.length > 0) {
      return "- Retrieval degraded; no passages available. See retrieval.errors in state.json.";
    }
    return "- No findings; retrieval returned no passages.";
  }
  const bullets = unique.map((p) => {
    const range = formatRange(p.line_start, p.line_end);
    const snippet = formatSnippet(p.text);
    return `- \`${p.path}:${range}\` – ${snippet}`;
  });
  return bullets.join("\n");
}

export function buildActionsSection(passages, errors = []) {
  const unique = dedupePassages(passages);
  if (!Array.isArray(unique) || unique.length === 0) {
    if (Array.isArray(errors) && errors.length > 0) {
      return "- [ ] Retrieval degraded; review problem statement and rerun once retrieval is healthy.";
    }
    return "- [ ] Review problem statement and add relevant context manually.";
  }
  const items = unique.map((p) => {
    const range = formatRange(p.line_start, p.line_end);
    return `- [ ] Review \`${p.path}:${range}\` in context of this plan.`;
  });
  return items.join("\n");
}

function dedupePassages(passages) {
  if (!Array.isArray(passages)) return [];
  const seen = new Set();
  const out = [];
  for (const p of passages) {
    const loc = `${p.path || ""}:${formatRange(p.line_start, p.line_end)}`;
    if (!p.path || !loc || seen.has(loc)) continue;
    seen.add(loc);
    out.push(p);
  }
  return out;
}

export function buildPlanYaml(state, passages, problemInfo) {
  const findings = dedupePassages(passages || []).map((p) => {
    const location = `${p.path}:${formatRange(p.line_start, p.line_end)}`;
    return {
      file: p.path,
      location,
      snippet: formatSnippet(p.text),
      score: typeof p.score === "number" ? p.score : null,
    };
  });

  let actions = findings.map((f) => ({
    id: `review-${slugify(f.file)}-${slugify(f.location)}`,
    kind: "review",
    target: f.location,
    description: `Review ${f.location} in context of plan "${state.label}".`,
  }));

  const problemText = (state.inputs?.problemText || problemInfo?.text || "").split("\n")[0].trim();

  if (state.label === "kickoff" && state.projectId) {
    const scaffoldActions = [
      {
        id: "scaffold-project-overview",
        kind: "scaffold-note",
        target: "project-overview",
        description: `Create or open Project Overview note for project "${state.projectId}".`,
      },
      {
        id: "scaffold-discovery-interview",
        kind: "scaffold-note",
        target: "discovery-interview",
        description: `Create or open Discovery Interview note for project "${state.projectId}".`,
      },
      {
        id: "scaffold-problem-backlog",
        kind: "scaffold-note",
        target: "problem-backlog",
        description: `Create or open Problem Backlog note for project "${state.projectId}".`,
      },
    ];
    actions = actions.concat(scaffoldActions);
  }

  return {
    version: 1,
    projectId: state.projectId ?? null,
    label: state.label,
    slug: state.slug,
    problem: problemText,
    problemPath: problemInfo?.path || null,
    createdAt: state.createdAt,
    findings,
    actions,
  };
}

function slugify(str) {
  return (str || "")
    .toString()
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    || "item";
}
