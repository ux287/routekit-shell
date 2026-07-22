/**
 * Story Validator v2 — Comprehensive story validation with quality/completeness scoring.
 * Consolidates checks from refine.mjs, plan-ready.mjs, and planner-preflight.mjs
 * into a single pass that returns a structured verdict.
 */
import fs from "fs";
import path from "path";
import { parseFrontmatter, resolveNotesDir } from "../dendron.mjs";
import { parseTargetsFromMarkdown } from "../llm/targets.mjs";
import { extractCreateFileDirectives } from "./planner-utils.mjs";
import { getTelemetryCollector } from "./telemetry/index.mjs";

/**
 * Parse targetFiles from frontmatter into structured format.
 * Accepts both legacy string[] and new TargetFile[] formats.
 *
 * Legacy: ["src/App.tsx", "src/Calculator.tsx"]
 * Structured: [{ path: "src/App.tsx", op: "MODIFY", desc: "...", ... }]
 *
 * Returns: { entries: TargetFile[], format: "legacy" | "structured" | "empty" }
 */
function parseStructuredTargetFiles(fmTargets, bodyTargets, projectRoot) {
  // No targets at all
  if ((!fmTargets || fmTargets.length === 0) && (!bodyTargets || bodyTargets.length === 0)) {
    return { entries: [], format: "empty" };
  }

  const raw = fmTargets && fmTargets.length > 0 ? fmTargets : bodyTargets;

  // Detect format: if first element is a string, it's legacy
  if (typeof raw[0] === "string") {
    // Legacy string[] — convert to structured with inferred op
    const entries = raw.map(p => {
      const absPath = path.resolve(projectRoot, p);
      const exists = fs.existsSync(absPath);
      return {
        path: p,
        op: exists ? "MODIFY" : "CREATE",
        desc: "",
        deps: [],
        content_hint: null,
        search_replace: [],
        _inferred: true,
      };
    });
    return { entries, format: "legacy" };
  }

  // Structured TargetFile[] format
  if (typeof raw[0] === "object" && raw[0].path) {
    const entries = raw.map(t => ({
      path: t.path || "",
      op: (t.op || "MODIFY").toUpperCase(),
      desc: t.desc || "",
      deps: Array.isArray(t.deps) ? t.deps : [],
      content_hint: t.content_hint || null,
      search_replace: Array.isArray(t.search_replace) ? t.search_replace : [],
      _inferred: false,
    }));
    return { entries, format: "structured" };
  }

  // Unknown format — treat as empty
  return { entries: [], format: "empty" };
}

const DEFAULT_THRESHOLDS = {
  qualityThreshold: 0.7,
  completenessThreshold: 0.8,
  maxAcForCreateFile: 4,
  maxAcForEditFile: 6,
};

/**
 * Load validation thresholds from project config, falling back to defaults.
 */
function loadThresholds(projectRoot) {
  try {
    const configPath = path.join(projectRoot, ".rks", "project.json");
    if (fs.existsSync(configPath)) {
      const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
      return { ...DEFAULT_THRESHOLDS, ...(config?.validation || {}) };
    }
  } catch {
    // fall through to defaults
  }
  return { ...DEFAULT_THRESHOLDS };
}

/**
 * Compute quality score (0.0–1.0) based on weighted checks.
 */
function computeQualityScore(body, frontmatter, hasCreateFiles) {
  let score = 0;

  // Has problem statement (0.15)
  if (/^#+ Problem/m.test(body)) score += 0.15;

  // Has solution/goal section (0.15)
  if (/^#+ (Solution|Goal)/m.test(body)) score += 0.15;

  // AC items use checkbox or numbered list format (0.15)
  const checkboxCount = (body.match(/- \[ \]/g) || []).length;
  const numberedAcCount = (body.match(/^\d+\.\s+/gm) || []).length;
  const totalAcItems = checkboxCount + numberedAcCount;
  if (totalAcItems > 0) score += 0.15;

  // AC items are specific/testable — no vague words in AC section (0.15)
  const acSection = extractSection(body, "Acceptance Criteria");
  const vagueInAc = /\b(maybe|possibly|TBD|might|could|should consider|if possible)\b/i.test(acSection);
  if (acSection && !vagueInAc) score += 0.15;

  // Code snippets present for EDIT targets (0.15)
  const codeBlockCount = (body.match(/```/g) || []).length / 2;
  if (codeBlockCount >= 1) score += 0.15;

  // CREATE FILE directives for new files (0.10)
  if (hasCreateFiles) score += 0.10;

  // Telemetry section present (0.05)
  if (/^#+ Telemetry/m.test(body)) score += 0.05;

  // No ambiguous language in body (0.10)
  const vagueInBody = /\b(maybe|possibly|TBD|might want to|could potentially)\b/i.test(body);
  if (!vagueInBody) score += 0.10;

  return Math.round(score * 100) / 100;
}

/**
 * Compute completeness score (0.0–1.0) based on weighted checks.
 */
function computeCompletenessScore(body, frontmatter, allTargets, createFileDirectives, thresholds) {
  let score = 0;

  // targetFiles populated (0.20)
  if (allTargets.length > 0) score += 0.20;

  // All target files exist or have CREATE directive (0.20)
  const allAccountedFor = allTargets.length > 0; // already validated in gaps
  if (allAccountedFor) score += 0.20;

  // testFile specified (0.10)
  if (frontmatter.testFile && String(frontmatter.testFile).trim()) score += 0.10;

  // Phase is ready (0.10)
  const phase = frontmatter.phase || "draft";
  if (["ready", "planned", "executed"].includes(phase)) score += 0.10;

  // Body length > 500 chars (0.10)
  if (body.length > 500) score += 0.10;

  // Has parent epic/story link (0.10)
  if (/\[\[backlog\./.test(body)) score += 0.10;

  // AC count within threshold for story type (0.20)
  const checkboxCount = (body.match(/- \[ \]/g) || []).length;
  const numberedAcItems = (body.match(/^\d+\.\s+/gm) || []).length;
  const totalAcCount = checkboxCount + numberedAcItems;
  const hasCreate = createFileDirectives.length > 0;
  const maxAc = hasCreate ? thresholds.maxAcForCreateFile : thresholds.maxAcForEditFile;
  if (totalAcCount > 0 && totalAcCount <= maxAc) score += 0.20;

  return Math.round(score * 100) / 100;
}

/**
 * Extract a markdown section by heading name.
 */
function extractSection(body, headingName) {
  const regex = new RegExp(`^#+ ${headingName}\\s*$`, "m");
  const match = regex.exec(body);
  if (!match) return "";
  const start = match.index + match[0].length;
  const rest = body.slice(start);
  const nextHeading = rest.search(/\n#+ /);
  return nextHeading !== -1 ? rest.slice(0, nextHeading) : rest;
}

/**
 * Detect sections present in the story body.
 */
function detectSections(body) {
  return {
    problem: /^#+ Problem/m.test(body),
    solution: /^#+ (Solution|Goal)/m.test(body),
    targetFiles: /^#+ Target Files/m.test(body),
    acceptanceCriteria: /^#+ Acceptance Criteria/m.test(body),
    telemetry: /^#+ Telemetry/m.test(body),
    testingRequirements: /^#+ (Testing Requirements|Test Cases)/m.test(body),
  };
}

/**
 * Run RAG benchmark against similar implemented stories.
 */
async function runRagBenchmark(projectRoot, problemId, frontmatter, body) {
  try {
    const { runRagQuery } = await import("../rag/index.mjs");
    const parentEpic = body.match(/\[\[(backlog\.epics\.[^\]]+)\]\]/)?.[1] || "";
    const query = `implemented story similar to ${problemId} ${parentEpic}`.trim();

    const result = await runRagQuery({
      projectRoot,
      projectId: "routekit-shell",
      q: query,
      k: 5,
      role: "scout",
    });

    if (!result?.ok || !result.matches?.length) {
      return { similarStories: [], avgQualityScore: 0, comparison: "no_data" };
    }

    // Filter to z_implemented stories only
    const implemented = result.matches.filter(m =>
      m.path?.includes("z_implemented") && m.status === "implemented"
    );

    if (implemented.length === 0) {
      return { similarStories: [], avgQualityScore: 0, comparison: "no_data" };
    }

    const similarStories = implemented.map(m => m.slug?.replace(/"/g, "") || m.path).slice(0, 3);

    // Compute avg score from matched stories (use semantic score as proxy)
    const avgScore = implemented.reduce((sum, m) => sum + (m.semanticScore || 0), 0) / implemented.length;
    const normalizedAvg = Math.round(Math.min(avgScore * 3, 1.0) * 100) / 100; // normalize to 0-1 range

    return {
      similarStories,
      avgQualityScore: normalizedAvg,
      comparison: "benchmark_available",
    };
  } catch {
    return { similarStories: [], avgQualityScore: 0, comparison: "rag_unavailable" };
  }
}

/**
 * Main validation function — returns structured verdict.
 */
export async function validateStory({ projectId, problemId, projectRoot }) {
  const collector = getTelemetryCollector();
  const startTime = Date.now();

  // Load thresholds
  const thresholds = loadThresholds(projectRoot);

  // Read story
  const notesDir = resolveNotesDir(projectRoot);
  const storyPath = path.join(notesDir, `${problemId}.md`);

  if (!fs.existsSync(storyPath)) {
    return {
      problemId,
      ready: false,
      currentPhase: "not_found",
      gaps: [{ field: "story", status: "not_found", priority: "high" }],
      suggestion: `Story file not found: ${problemId}.md`,
    };
  }

  const content = fs.readFileSync(storyPath, "utf8");
  const { data: frontmatter, content: body } = parseFrontmatter(content);

  // Gather target files — supports both legacy string[] and structured TargetFile[]
  const fmTargets = frontmatter.targetFiles || [];
  const bodyTargets = parseTargetsFromMarkdown(body);
  const structured = parseStructuredTargetFiles(fmTargets, bodyTargets, projectRoot);
  const allTargets = [...new Set(structured.entries.map(e => e.path))];
  const createFileDirectives = extractCreateFileDirectives(body);
  const hasCreateFiles = createFileDirectives.length > 0
    || structured.entries.some(e => e.op === "CREATE");

  // Detect sections
  const sections = detectSections(body);

  // Count AC items (checkboxes + numbered list items)
  const checkboxAcCount = (body.match(/- \[ \]/g) || []).length;
  const numberedAcCount = (body.match(/^\d+\.\s+/gm) || []).length;
  const acCount = checkboxAcCount + numberedAcCount;
  const codeSnippetCount = Math.floor((body.match(/```/g) || []).length / 2);

  // Compute scores
  const qualityScore = computeQualityScore(body, frontmatter, hasCreateFiles);
  const completenessScore = computeCompletenessScore(body, frontmatter, allTargets, createFileDirectives, thresholds);

  // Detect gaps
  const gaps = [];
  const phase = frontmatter.phase || "draft";

  if (allTargets.length === 0) {
    gaps.push({ field: "targetFiles", status: "missing", priority: "high" });
  }

  if (!["ready", "planned", "executed"].includes(phase)) {
    gaps.push({ field: "phase", status: "invalid", priority: "high", current: phase });
  }

  if (acCount === 0) {
    gaps.push({ field: "acceptanceCriteria", status: "missing", priority: "high" });
  }

  const maxAc = hasCreateFiles ? thresholds.maxAcForCreateFile : thresholds.maxAcForEditFile;
  if (acCount > maxAc) {
    gaps.push({ field: "acceptanceCriteria", status: "exceeds_threshold", priority: "high", count: acCount, max: maxAc });
  }

  // Check target files exist or have CREATE directives
  for (const target of allTargets) {
    const targetPath = path.resolve(projectRoot, target);
    if (!fs.existsSync(targetPath)) {
      const hasDirective = createFileDirectives.some(d => d === target || d.endsWith(target) || target.endsWith(d));
      if (!hasDirective) {
        gaps.push({ field: "targetFile", status: "missing_create_directive", priority: "high", file: target });
      }
    }
  }

  // --- Execution-readiness checks ---

  // FIX 2: targetFiles MUST be in frontmatter (not just parsed from body)
  if (fmTargets.length === 0 && bodyTargets.length > 0) {
    gaps.push({ field: "targetFiles", status: "not_in_frontmatter", priority: "high",
      detail: "targetFiles found in body but not in frontmatter. Move to frontmatter for planner/delivery to consume." });
  }

  // FIX 3: Existing target files need SEARCH/REPLACE or modification spec
  for (const target of allTargets) {
    const targetPath = path.resolve(projectRoot, target);
    if (fs.existsSync(targetPath)) {
      // File exists — story must specify what to change
      const hasSearchReplace = new RegExp(
        `(SEARCH/REPLACE|<<<<<<|======|>>>>>>|\\bdiff\\b|\\bpatch\\b).*${target.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}|${target.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}.*(SEARCH/REPLACE|<<<<<<|======|>>>>>>|\\bdiff\\b|\\bpatch\\b)`,
        'i'
      ).test(body);
      const hasCodeBlockForFile = body.includes(target) && (body.match(/```/g) || []).length >= 2;
      if (!hasSearchReplace && !hasCodeBlockForFile) {
        gaps.push({ field: "modification_spec", status: "missing", priority: "high", file: target,
          detail: `Existing file "${target}" has no SEARCH/REPLACE block or code modification spec. Delivery agent cannot determine what to change.` });
      }
    }
  }

  // FIX 4: CREATE FILE directives need content skeleton
  for (const target of allTargets) {
    const targetPath = path.resolve(projectRoot, target);
    if (!fs.existsSync(targetPath)) {
      const hasDirective = createFileDirectives.some(
        d => d === target || d.endsWith(target) || target.endsWith(d)
      );
      if (hasDirective) {
        // Has CREATE directive — check for content skeleton (code block after directive)
        const createPattern = new RegExp(
          `CREATE\\s+(FILE\\s+)?${target.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}[\\s\\S]{0,200}\`\`\``,
          'i'
        );
        if (!createPattern.test(body)) {
          gaps.push({ field: "create_skeleton", status: "missing", priority: "medium", file: target,
            detail: `CREATE directive for "${target}" has no content skeleton. Include a code block with the file structure.` });
        }
      }
    }
  }

  // FIX 5: testFile missing from frontmatter is high priority
  if (!frontmatter.testFile || !String(frontmatter.testFile).trim()) {
    gaps.push({ field: "testFile", status: "missing", priority: "high",
      detail: "No testFile in frontmatter. Test agent cannot verify without it." });
  }

  // --- Structured targetFiles validation ---

  // Warn on legacy format (not blocking, but encourages migration)
  if (structured.format === "legacy") {
    gaps.push({ field: "targetFiles", status: "legacy_format", priority: "low",
      detail: "targetFiles uses legacy string[] format. Upgrade to structured format with op, desc, content_hint, search_replace for better planner output." });
  }

  // Validate structured entries
  if (structured.format === "structured") {
    for (const entry of structured.entries) {
      const validOps = ["CREATE", "MODIFY", "DELETE"];
      if (!validOps.includes(entry.op)) {
        gaps.push({ field: "targetFiles", status: "invalid_op", priority: "high",
          file: entry.path, detail: `Invalid op "${entry.op}" — must be CREATE, MODIFY, or DELETE.` });
      }

      // CREATE needs content_hint (>= 50 chars) or search in body for CREATE directive
      if (entry.op === "CREATE") {
        const hasHint = entry.content_hint && entry.content_hint.length >= 50;
        const hasBodyDirective = createFileDirectives.some(
          d => d === entry.path || d.endsWith(entry.path) || entry.path.endsWith(d)
        );
        if (!hasHint && !hasBodyDirective) {
          gaps.push({ field: "targetFiles", status: "create_missing_hint", priority: "high",
            file: entry.path, detail: `CREATE entry for "${entry.path}" has no content_hint (min 50 chars) or CREATE directive in body. Planner cannot generate file content.` });
        }
        // CREATE path should not exist on disk
        const absPath = path.resolve(projectRoot, entry.path);
        if (fs.existsSync(absPath)) {
          gaps.push({ field: "targetFiles", status: "create_exists", priority: "high",
            file: entry.path, detail: `CREATE entry for "${entry.path}" but file already exists. Should be MODIFY.` });
        }
      }

      // MODIFY needs search_replace[] or desc >= 30 chars
      if (entry.op === "MODIFY") {
        const hasSearchReplace = entry.search_replace && entry.search_replace.length > 0;
        const hasDesc = entry.desc && entry.desc.length >= 30;
        if (!hasSearchReplace && !hasDesc) {
          gaps.push({ field: "targetFiles", status: "modify_missing_spec", priority: "high",
            file: entry.path, detail: `MODIFY entry for "${entry.path}" has no search_replace blocks and desc is too short (< 30 chars). Planner cannot determine what to change.` });
        }
        // MODIFY path should exist on disk
        const absPath = path.resolve(projectRoot, entry.path);
        if (!fs.existsSync(absPath)) {
          gaps.push({ field: "targetFiles", status: "modify_not_found", priority: "high",
            file: entry.path, detail: `MODIFY entry for "${entry.path}" but file does not exist. Should be CREATE.` });
        }
      }

      // DELETE path should exist on disk
      if (entry.op === "DELETE") {
        const absPath = path.resolve(projectRoot, entry.path);
        if (!fs.existsSync(absPath)) {
          gaps.push({ field: "targetFiles", status: "delete_not_found", priority: "medium",
            file: entry.path, detail: `DELETE entry for "${entry.path}" but file does not exist.` });
        }
      }
    }

    // Check for duplicate paths
    const paths = structured.entries.map(e => e.path);
    const dupes = paths.filter((p, i) => paths.indexOf(p) !== i);
    if (dupes.length > 0) {
      gaps.push({ field: "targetFiles", status: "duplicate_paths", priority: "high",
        detail: `Duplicate paths in targetFiles: ${[...new Set(dupes)].join(", ")}` });
    }

    // Check deps form a valid DAG (no cycles)
    const pathSet = new Set(paths);
    for (const entry of structured.entries) {
      for (const dep of entry.deps) {
        if (!pathSet.has(dep)) {
          gaps.push({ field: "targetFiles", status: "invalid_dep", priority: "medium",
            file: entry.path, detail: `Dep "${dep}" in "${entry.path}" is not in targetFiles.` });
        }
      }
    }
  }

  if (qualityScore < thresholds.qualityThreshold) {
    gaps.push({ field: "quality", status: "below_threshold", priority: "medium", score: qualityScore, threshold: thresholds.qualityThreshold });
  }

  if (completenessScore < thresholds.completenessThreshold) {
    gaps.push({ field: "completeness", status: "below_threshold", priority: "medium", score: completenessScore, threshold: thresholds.completenessThreshold });
  }

  // RAG benchmark
  const benchmark = await runRagBenchmark(projectRoot, problemId, frontmatter, body);

  // Detect fenced @@SEARCH/@@REPLACE/@@END blocks — these cause file resolution
  // to fail in reviewer mode because the file heading is no longer adjacent to @@SEARCH.
  const formatErrors = [];
  const atAtMarkers = ['@@SEARCH', '@@REPLACE', '@@END'];
  const hasAtAtMarkers = atAtMarkers.some(m => body.includes(m));
  if (hasAtAtMarkers) {
    // Check if any @@SEARCH/@@REPLACE/@@END marker is immediately preceded by a fence line
    const fencedAtAtPattern = /^```[\w]*\s*\n(?:.*\n)*?@@(?:SEARCH|REPLACE|END)/m;
    if (fencedAtAtPattern.test(body)) {
      formatErrors.push({
        type: 'fenced_at_markers',
        message: 'Format error: @@SEARCH/@@REPLACE/@@END blocks must NOT be wrapped in markdown code fences. Use bare markers (no triple-backtick wrapper). Fenced blocks cause file resolution to fail in reviewer mode.',
      });
    }
  }

  // Determine readiness
  const highPriorityGaps = gaps.filter(g => g.priority === "high");
  const ready = highPriorityGaps.length === 0
    && formatErrors.length === 0
    && qualityScore >= thresholds.qualityThreshold
    && completenessScore >= thresholds.completenessThreshold;

  // Emit telemetry
  const latencyMs = Date.now() - startTime;
  collector.emit("validate_story.complete", projectId, {
    problemId,
    ready,
    qualityScore,
    completenessScore,
    gapCount: gaps.length,
    latencyMs,
  });

  // Lifecycle boundary emits
  try {
    if (ready) {
      collector.emit("story.validated", projectId, { storyId: problemId, score: qualityScore, phase });
    } else {
      collector.emit("story.validation_failed", projectId, {
        storyId: problemId,
        issues: [
          ...highPriorityGaps.map(g => g.field),
          ...formatErrors.map(e => e.type),
        ],
        phase,
      });
    }
  } catch (e) { /* telemetry is best-effort */ }

  if (ready) {
    return {
      problemId,
      ready: true,
      validated: {
        frontmatter: {
          targetFiles: allTargets,
          targetFilesFormat: structured.format,
          structuredTargets: structured.format === "structured" ? structured.entries : undefined,
          phase,
          testFile: frontmatter.testFile || null,
          acCount,
        },
        body: {
          qualityScore,
          completenessScore,
          sections,
          codeSnippetCount,
          createFileDirectives,
        },
        benchmark,
      },
    };
  }

  // Not ready
  const suggestion = formatErrors.length > 0
    ? `Story has ${formatErrors.length} format error(s). Fix @@SEARCH/@@REPLACE/@@END block formatting before planning.`
    : highPriorityGaps.length > 0
      ? `Story has ${highPriorityGaps.length} blocking issue(s). Fix before planning.`
      : `Scores below threshold — quality: ${qualityScore} (need ${thresholds.qualityThreshold}), completeness: ${completenessScore} (need ${thresholds.completenessThreshold}).`;

  return {
    problemId,
    ready: false,
    currentPhase: phase,
    gaps,
    formatErrors: formatErrors.length > 0 ? formatErrors : undefined,
    suggestion,
    benchmark,
    thresholds,
  };
}
