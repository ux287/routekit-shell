import fs from "fs";
import path from "path";
import { parseTargetsFromMarkdown, loadEditableTargets, looksLikeGlob } from "./targets.mjs";
import { callAnthropicChatWithUsage, callOpenAiChat, loadEnv, createOpenAiClient, createAnthropicClient, DEFAULT_LLM_TIMEOUT_MS, DEFAULT_LLM_MAX_TOKENS } from "./clients.mjs";
import { analyzeTestContent } from "../server/test-static-analysis.mjs";
import { isSynthesizedBody } from "../server/plan-quality.mjs";

function normalizeText(s = "") {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function tokensOf(s = "") {
  const norm = normalizeText(s);
  return norm ? norm.split(" ").filter(Boolean) : [];
}

function jaccardScore(aTokens = [], bTokens = []) {
  const aSet = new Set(aTokens);
  const bSet = new Set(bTokens);
  if (!aSet.size && !bSet.size) return 0;
  let intersection = 0;
  for (const t of aSet) {
    if (bSet.has(t)) intersection += 1;
  }
  const union = new Set([...aSet, ...bSet]).size || 1;
  return intersection / union;
}

function computeSemanticClusters(steps = []) {
  const metas = (steps || [])
    .filter(Boolean)
    .map((s) => {
      const title = s.title || s.description || s.path || "";
      const pathVal = s.path || "";
      const content = typeof s.content === "string" ? s.content : "";
      const tokens = tokensOf([title, content].join(" "));
      return {
        id: s.id || s.title || pathVal || `step-${Math.random().toString(36).slice(2, 8)}`,
        title,
        path: pathVal,
        tokens,
      };
    });

  const clusters = [];
  let clusterIdx = 1;
  const addCluster = (stepIds, label, rationale, tags = []) => {
    const uniqueIds = Array.from(new Set(stepIds)).filter(Boolean);
    if (uniqueIds.length < 2) return;
    clusters.push({
      clusterId: `cluster-${clusterIdx++}`,
      label,
      stepIds: uniqueIds,
      rationale,
      tags,
    });
  };

  // Path-based clustering
  const byPath = new Map();
  metas.forEach((m) => {
    if (!m.path) return;
    if (!byPath.has(m.path)) byPath.set(m.path, []);
    byPath.get(m.path).push(m.id);
  });
  for (const [p, ids] of byPath.entries()) {
    if (ids.length > 1) {
      addCluster(ids, `Edits to ${p}`, "Multiple steps target the same path", ["path"]);
    }
  }

  // Token overlap clustering
  const THRESH = 0.4;
  const seenPairs = new Set();
  for (let i = 0; i < metas.length; i += 1) {
    for (let j = i + 1; j < metas.length; j += 1) {
      const a = metas[i];
      const b = metas[j];
      const key = `${a.id}::${b.id}`;
      if (seenPairs.has(key)) continue;
      seenPairs.add(key);
      const score = jaccardScore(a.tokens, b.tokens);
      if (score >= THRESH) {
        addCluster(
          [a.id, b.id],
          `Similar content (${(score * 100).toFixed(0)}% overlap)`,
          `Titles/contents overlap (score=${score.toFixed(2)})`,
          ["tokens"]
        );
      }
    }
  }

  if (!clusters.length) {
    return { clusters: [], note: "no clusters" };
  }
  return { clusters, note: null };
}

function runConcernDecompositionPass(requirements = "") {
  const concerns = [];
  const lines = String(requirements || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const slugify = (s) =>
    normalizeText(s)
      .replace(/\s+/g, "-")
      .replace(/[^a-z0-9-]/g, "")
      .replace(/^-+|-+$/g, "") || `concern-${concerns.length + 1}`;

  lines.forEach((line) => {
    // Treat bullets or sentences as candidate concerns
    const label = line.length > 80 ? `${line.slice(0, 77)}…` : line;
    const id = slugify(label);
    if (!id) return;
    concerns.push({
      id,
      label,
      desc: line,
    });
  });

  // Remove duplicates by id
  const seen = new Set();
  const deduped = [];
  concerns.forEach((c) => {
    if (seen.has(c.id)) return;
    seen.add(c.id);
    deduped.push(c);
  });

  return {
    concerns: deduped,
    rationale: `derived from ${deduped.length} requirement line(s)`,
  };
}

function replayPath(runFolder) {
  if (!runFolder) return null;
  return path.join(runFolder, "llm-output.json");
}

function maybeReadReplay(runFolder) {
  const p = replayPath(runFolder);
  if (!p) return null;
  if (fs.existsSync(p)) {
    try {
      return JSON.parse(fs.readFileSync(p, "utf8"));
    } catch {
      return null;
    }
  }
  return null;
}

function writeReplay(runFolder, payload) {
  if (!runFolder) return;
  try {
    fs.writeFileSync(replayPath(runFolder), JSON.stringify(payload, null, 2));
  } catch {
    // ignore
  }
}

function mergeMeta(existingMeta = {}, additions = {}) {
  return { ...(existingMeta || {}), ...additions };
}

const PLANNER_SYSTEM_PROMPT = "You are the RouteKit planner. Respond ONLY with valid JSON (no markdown fences). CRITICAL: Every step MUST be actionable — use create_file, search_replace, edit_file, delete_file, or run_command. NEVER produce note steps. For EXISTING files, ALWAYS prefer search_replace with exact verbatim code from RAG snippets. IMPORTANT: When generating any search_replace edits, you MUST use only verbatim code from the RAG code snippets included in the prompt. Do NOT guess or invent code patterns. If the required code is not present in the provided snippets, respond with a plan step that requests more code context (e.g. 'needs_code_context'). CRITICAL: Before generating search_replace steps, verify that each SEARCH pattern exists verbatim in the RAG code snippets provided. Copy exact lines including whitespace and indentation — do not reconstruct code from understanding. If you cannot find the exact code in the snippets, use a needs_code_context step instead of guessing.";

export function parsePlannerJson(raw) {
  if (!raw) return null;
  let text = raw.trim();
  text = text.replace(/^```(?:json)?\s*/i, "").replace(/```$/i, "").trim();
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function validateSearchReplacePatterns(projectRoot, plan, createdPaths) {
  if (!plan || !Array.isArray(plan.steps)) return { ok: true, needs_refinement: false, diagnostics: [] };
  const diagnostics = [];
  let needs_refinement = false;
  for (const s of plan.steps) {
    // Existing validation for search_replace edits
    if (s.action === "search_replace" && s.path && Array.isArray(s.edits)) {
      // Same-plan-created-path exemption (N2 Option 1): skip on-disk validation for
      // a path a create_file step in this plan will produce (created at apply time).
      if (createdPaths && createdPaths.has(s.path)) continue;
      const targetPath = path.join(projectRoot, s.path);
      let content = null;
      try {
        content = fs.readFileSync(targetPath, "utf8");
      } catch (err) {
        diagnostics.push({ path: s.path, message: `failed to read file: ${err?.message}` });
        needs_refinement = true;
        continue;
      }
      for (const e of s.edits) {
        if (!e || typeof e.search !== "string") continue;
        if (!content.includes(e.search)) {
          needs_refinement = true;
          // Find nearby content for LLM refinement
          const lines = content.split("\n");
          const searchLines = e.search.split("\n");
          const firstSearchLine = searchLines[0]?.trim() || "";
          let suggestion = null;
          if (firstSearchLine) {
            const idx = lines.findIndex(l => l.includes(firstSearchLine.slice(0, 30)));
            if (idx >= 0) {
              const start = Math.max(0, idx - 2);
              const end = Math.min(lines.length, idx + 5);
              suggestion = lines.slice(start, end).join("\n");
            }
          }
          diagnostics.push({
            path: s.path,
            missingSearch: e.search.slice(0, 200),
            message: `search pattern not found in ${s.path}`,
            suggestion,
          });
        }
      }
    }

    // New heuristic: flag edit_file steps that target large existing files (>500 lines)
    if (s.action === "edit_file" && s.path) {
      const tPath = path.join(projectRoot, s.path);
      try {
        const txt = fs.readFileSync(tPath, "utf8");
        const lines = txt.split("\n").length;
        if (lines > 500) {
          needs_refinement = true;
          diagnostics.push({
            path: s.path,
            message: `target file appears large (${lines} lines). Prefer search_replace or split edits; require anchor markers when using edit_file.`,
          });
        }
      } catch (err) {
        // If file can't be read (maybe new), do not flag here
      }
    }
  }
  return { ok: true, needs_refinement, diagnostics };
}

export function normalizePlannerSteps(parsedSteps = []) {
  const containsDiffMarkers = (text) => {
    if (!text || typeof text !== "string") return false;
    if (/diff --git/i.test(text)) return true;
    if (/^@@/m.test(text)) return true;
    if (/^\+\+\+ /m.test(text) || /^--- /m.test(text)) return true;
    const lines = text.split("\n");
    return lines.some((line) => {
      if (/^---\s*$/.test(line) || /^\+\+\+\s*$/.test(line)) return false;
      return /^\+[^\s]/.test(line) || /^-[^\s]/.test(line);
    });
  };

  let diffRejected = false;

  const normalized = parsedSteps
    .filter(Boolean)
    .map((step, idx) => {
      const baseAction = step.action || "note";
      const content = step.content ?? null;
      const isNonEmptyContent = typeof content === "string" && content.trim().length > 0;
      const looksLikeCode =
        isNonEmptyContent &&
        (content.includes("\n") ||
          content.includes("import ") ||
          content.includes("function") ||
          content.includes("{") ||
          content.includes("};") ||
          content.includes("</") ||
          content.includes("const "));

      const coercedAction =
        baseAction === "note" && looksLikeCode ? "edit_file" : baseAction;

      const hasDiff = containsDiffMarkers(content);
      if (hasDiff) diffRejected = true;

      return {
        id: step.id || `step-${String(idx + 1).padStart(3, "0")}`,
        title: step.title || step.description || step.path || `Step ${idx + 1}`,
        description: step.description || null,
        action: coercedAction,
        path: step.path ?? null,
        content: hasDiff ? null : content,
        edits: Array.isArray(step.edits) ? step.edits : null,
        command: step.command ?? null,
        order: step.order ?? idx + 1,
        _diffRejected: hasDiff,
        ...(step.concernId ? { concernId: step.concernId } : {}),
        ...(step.clusterId ? { clusterId: step.clusterId } : {}),
        ...(step.groupId ? { groupId: step.groupId } : {}),
        ...(step.scope ? { scope: step.scope } : {}),
        ...(step.targetId ? { targetId: step.targetId } : {}),
      };
    });

  return { steps: normalized, hasExecutableWithContent: computeHasExecutableWithContent(normalized), diffRejected };
}

/**
 * backlog.fix.planner-greenfield-body-synthesis: "has content" means a REAL BODY, judged by the
 * shared isSynthesizedBody predicate — not merely a non-empty string. A prose step like
 * `content: "Create a Calculator component that handles the four operations."` is a non-empty
 * string, so the old rule classified the plan "executable" while the server-side coverage gate
 * (which is stricter) rejected it — a divergence that stranded greenfield plans in a retry loop
 * neither side could resolve. Both sides now ask the same question.
 *
 * Exported as one function because body synthesis RE-COMPUTES this after swapping real bodies in;
 * two copies of the rule would be two chances for it to drift.
 */
export function computeHasExecutableWithContent(steps) {
  return (steps || []).some(
    (s) =>
      ((s.action === "edit_file" || s.action === "create_file") &&
        isSynthesizedBody(s.content, s.path)) ||
      (s.action === "search_replace" &&
        Array.isArray(s.edits) &&
        s.edits.length > 0) ||
      (s.action === "delete_file" && s.path)
  );
}

export function classifyPlan({ parsed, hasExecutableWithContent, diffRejected }) {
  if (!parsed || diffRejected) return "error";
  return hasExecutableWithContent ? "executable" : "note_only";
}

// ---------------------------------------------------------------------------
// Post-plan test content generation
// ---------------------------------------------------------------------------

const TEST_FILE_PATTERNS = [".test.", ".spec.", "__tests__"];

function isTestFilePath(filePath) {
  return filePath && TEST_FILE_PATTERNS.some((p) => filePath.includes(p));
}

function hasEmptyTestBodies(content) {
  if (!content || typeof content !== "string") return true;
  // A test file with real assertions has expect() or assert()
  return !content.includes("expect(") && !content.includes("assert(");
}

function stripMarkdownFences(text) {
  if (!text) return text;
  const trimmed = text.trim();
  const fenceMatch = trimmed.match(
    /^```(?:javascript|js|typescript|ts)?\s*\n([\s\S]*?)```\s*$/
  );
  if (fenceMatch) return fenceMatch[1].trim();
  return trimmed;
}

export function buildTestGenerationPrompt({ testPath, testExemplar, requirements, sourceChanges, existingContent }) {
  const parts = [
    "You are generating a test file. Output ONLY the complete file content as raw JavaScript/TypeScript code.",
    "No JSON wrapping. No markdown fences. No prose outside the code.",
    "",
    `Test file path: ${testPath}`,
    "",
    "Follow this test pattern EXACTLY (imports, describe/it structure, assertion style):",
    "```",
    testExemplar,
    "```",
    "",
    "Requirements to test:",
    requirements,
  ];

  if (sourceChanges) {
    parts.push("", "Source code changes being tested:", sourceChanges);
  }

  if (existingContent && existingContent.trim()) {
    parts.push(
      "",
      "Skeleton to fill in (replace empty it() bodies with real assertions):",
      existingContent
    );
  }

  parts.push(
    "",
    "RULES:",
    "- Output ONLY valid JavaScript/TypeScript code",
    "- Every it() block MUST contain at least one expect() or assert() call",
    "- Do NOT put the ONLY assertion inside a loop body — a loop-internal expect() may never run on an empty collection. Collect failures inside the loop, then assert once OUTSIDE the loop (e.g. const failures = []; for (...) { if (bad) failures.push(x); } expect(failures).toEqual([]))",
    "- For COMPUTED floating-point values, use toBeCloseTo(value, digits) — NOT exact toBe(value). Exact-float equality (e.g. toBe(10.22)) is fragile. Integer equality with toBe() is fine.",
    "- Follow the import style from the test pattern above",
    "- Test the actual source code changes shown above",
    "- Do NOT output markdown fences, JSON, or any text outside the code"
  );

  return parts.join("\n");
}

/**
 * Pre-emit self-check: run the same test_quality gate (analyzeTestContent) the downstream
 * validator uses over a generated test string, so the planner returns the SAME verdict the gate
 * would and never emits a test its own gate rejects (assertion-free loop bodies, exact-float
 * toBe, empty/no-assertion tests). Returns { ok, issues, warnings }.
 */
export function selfCheckGeneratedTest(content, fileLabel = '<generated>') {
  return analyzeTestContent(content, fileLabel);
}

const TEST_GEN_TIMEOUT_MS = 60000;
export const TEST_GEN_SYSTEM_PROMPT =
  "You are a test code generator. Output ONLY raw JavaScript/TypeScript code. No JSON, no markdown fences, no prose outside the code. Every test must contain real assertions that execute — never leave the sole assertion inside a loop body; collect failures and assert once outside the loop. Use toBeCloseTo for computed floating-point comparisons, not exact toBe.";

// backlog.fix.planner-greenfield-body-synthesis: the raw-code channel is no longer test-only, so
// the system prompt is a parameter. It defaults to TEST_GEN_SYSTEM_PROMPT — existing callers are
// unchanged — and the body synthesizer passes the source-file variant below.
export const FILE_GEN_SYSTEM_PROMPT =
  "You are a source code generator. Output ONLY the raw, complete, final contents of the ONE file requested. No JSON, no markdown fences, no prose, no commentary before or after the code. Never DESCRIBE what the file should contain — WRITE it. Your output is written verbatim to disk, so it must be complete and immediately valid for its file type. Do not emit a stub, a skeleton, or a file whose body is only comments/TODOs.";

async function callLlmForRawCode(env, prompt, llmContext = {}, systemPrompt = TEST_GEN_SYSTEM_PROMPT) {
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), TEST_GEN_TIMEOUT_MS);

  try {
    let raw = "";
    if (env.provider === "openai") {
      const client = createOpenAiClient(env);
      if (!client) throw new Error("OpenAI client not configured");
      raw = await callOpenAiChat({
        client,
        model: env.model,
        prompt,
        signal: controller.signal,
        systemPrompt,
      });
    } else if (env.provider === "anthropic") {
      const client = createAnthropicClient(env);
      if (!client) throw new Error("Anthropic client not configured");
      ({ content: raw } = await callAnthropicChatWithUsage({
        client,
        model: env.model,
        prompt,
        signal: controller.signal,
        systemPrompt,
        context: llmContext,
      }));
    } else {
      throw new Error(`Unsupported provider: ${env.provider}`);
    }
    return stripMarkdownFences(raw);
  } finally {
    clearTimeout(timeoutHandle);
  }
}

/**
 * Post-plan enrichment: for any create_file test steps with empty assertion
 * bodies, make a focused LLM call that outputs raw code (not JSON-embedded).
 * This bypasses the JSON-embedded code generation limitation that causes the
 * planner to truncate test function bodies.
 */
async function enrichTestFileContent({ actions, testExemplar, requirements, env, llmContext = {} }) {
  if (!testExemplar || !actions?.length) return actions;

  // Collect source changes from non-test plan steps for context
  const sourceChanges = actions
    .filter(
      (a) =>
        (a.action === "edit_file" || a.action === "search_replace" || a.action === "create_file") &&
        !isTestFilePath(a.path)
    )
    .map((a) => {
      if (a.action === "search_replace" && Array.isArray(a.edits)) {
        const editsText = a.edits
          .map((e) => `  Replace:\n${e.search}\n  With:\n${e.replace}`)
          .join("\n");
        return `File: ${a.path}\n${editsText}`;
      }
      const preview = (a.content || "").slice(0, 3000);
      return `File: ${a.path}\n${preview}`;
    })
    .join("\n---\n");

  const enriched = [...actions];
  let enrichedCount = 0;

  for (let i = 0; i < enriched.length; i++) {
    const step = enriched[i];
    if (step.action !== "create_file") continue;
    if (!isTestFilePath(step.path)) continue;
    if (!hasEmptyTestBodies(step.content)) continue;

    console.error(`[planner] enrichTestFileContent: generating content for ${step.path}`);

    const testPrompt = buildTestGenerationPrompt({
      testPath: step.path,
      testExemplar,
      requirements,
      sourceChanges,
      existingContent: step.content,
    });

    try {
      let rawCode = await callLlmForRawCode(env, testPrompt, llmContext);
      let accepted = rawCode && !hasEmptyTestBodies(rawCode) && selfCheckGeneratedTest(rawCode, step.path).ok;

      // Pre-emit self-check: never emit a test our own test_quality gate would reject. If the
      // first attempt trips a hygiene check (loop_only_assertion, float_exact_equality, ...),
      // make ONE repair attempt naming the exact violations — far cheaper than burning an exec
      // attempt on a test that fails at runtime.
      if (rawCode && !accepted) {
        const verdict = selfCheckGeneratedTest(rawCode, step.path);
        const issueList = verdict.issues.map((iss) => `- ${iss.type}: ${iss.message}`).join("\n");
        if (issueList) {
          const repairPrompt = `${testPrompt}\n\nYour previous output was REJECTED by the test-quality gate for:\n${issueList}\n\nRegenerate the COMPLETE file fixing these — put executing assertions OUTSIDE loop bodies (collect failures, assert once after), and use toBeCloseTo for computed floating-point comparisons. Output ONLY the code.`;
          try {
            const repaired = await callLlmForRawCode(env, repairPrompt, llmContext);
            if (repaired && !hasEmptyTestBodies(repaired) && selfCheckGeneratedTest(repaired, step.path).ok) {
              rawCode = repaired;
              accepted = true;
            }
          } catch (e) {
            console.error(`[planner] enrichTestFileContent repair failed for ${step.path}: ${e.message}`);
          }
        }
      }

      if (accepted) {
        enriched[i] = { ...step, content: rawCode };
        enrichedCount++;
        console.error(
          `[planner] enrichTestFileContent: enriched ${step.path} (${rawCode.length} chars, passes self-check)`
        );
      } else {
        console.error(
          `[planner] enrichTestFileContent: LLM output for ${step.path} failed self-check/assertions, keeping original`
        );
      }
    } catch (err) {
      console.error(`[planner] enrichTestFileContent failed for ${step.path}: ${err.message}`);
    }
  }

  if (enrichedCount > 0) {
    console.error(`[planner] enrichTestFileContent: enriched ${enrichedCount} test file(s)`);
  }
  return enriched;
}

function buildFileGenerationPrompt({ filePath, requirements, planContext, existingContent }) {
  const intent = existingContent && String(existingContent).trim()
    ? `The plan described this file's intent as:\n"""\n${String(existingContent).slice(0, 2000)}\n"""\nThat text is a DESCRIPTION, not the file. Write the real file it describes.`
    : `The plan named this file as a target but supplied no body. Write it from the requirements.`;

  return `Write the complete contents of the file: ${filePath}

${intent}

# Requirements
${requirements || "(none supplied)"}

# Other files in this same plan (keep imports, names, and paths consistent with these)
${planContext || "(none)"}

Write the entire file, top to bottom, exactly as it should exist on disk. Infer the correct language, framework, and conventions from the file extension and the surrounding plan. Output ONLY the file contents.`;
}

/**
 * Post-plan enrichment (backlog.fix.planner-greenfield-body-synthesis): for any create_file step
 * whose "content" is not a real body — empty, a comment/TODO-only stub, or PROSE NARRATION such
 * as "Create a Calculator component that handles the four operations" — make a focused LLM call
 * that returns raw code, and swap the real body in.
 *
 * This is the greenfield fix. When a story's targets are all op:create and RAG has no prior code
 * to draw on, the JSON-embedded planner reliably emits narration instead of file bodies. The
 * server's coverage gate then sees no authored create, and the plan dies in a retry loop with a
 * generic `has_note_steps` / `output_invalid` that no refinement can escape — the exact failure in
 * the clean-machine UAT. Synthesizing the body HERE, upstream of every gate, converts that dead
 * end into a real plan.
 *
 * Deliberately NOT gated on `testExemplar` (unlike enrichTestFileContent): a fresh child has no
 * exemplar, and a fresh child is precisely the case this must rescue.
 */
export async function enrichCreateFileContent({ actions, requirements, env, llmContext = {} }) {
  if (!actions?.length) return actions;

  const needy = actions.filter(
    (a) => a?.action === "create_file" && a?.path && !isSynthesizedBody(a.content, a.path)
  );
  if (!needy.length) return actions;

  // Give the generator the rest of the plan so imports/names line up across files.
  const planContext = actions
    .filter((a) => a?.path && !needy.includes(a))
    .map((a) => `- ${a.path}: ${(a.description || a.action || "").toString().slice(0, 160)}`)
    .join("\n");

  const enriched = [...actions];
  let enrichedCount = 0;

  for (let i = 0; i < enriched.length; i++) {
    const step = enriched[i];
    if (!needy.includes(step)) continue;

    console.error(`[planner] enrichCreateFileContent: synthesizing body for ${step.path}`);

    const prompt = buildFileGenerationPrompt({
      filePath: step.path,
      requirements,
      planContext,
      existingContent: step.content,
    });

    try {
      const rawCode = await callLlmForRawCode(env, prompt, llmContext, FILE_GEN_SYSTEM_PROMPT);

      // Accept only a body that passes the SAME predicate that judged it needy — otherwise we
      // would swap one unauthorable body for another and re-enter the loop we are here to break.
      // A test file must additionally clear the test-quality self-check, exactly as it would if
      // enrichTestFileContent had produced it.
      const isTest = isTestFilePath(step.path);
      const accepted =
        !!rawCode &&
        isSynthesizedBody(rawCode, step.path) &&
        (!isTest || (!hasEmptyTestBodies(rawCode) && selfCheckGeneratedTest(rawCode, step.path).ok));

      if (accepted) {
        enriched[i] = { ...step, content: rawCode };
        enrichedCount++;
        console.error(
          `[planner] enrichCreateFileContent: synthesized ${step.path} (${rawCode.length} chars)`
        );
      } else {
        // Leave the step as-is. The downstream coverage gate then fails LOUD and refinable-false
        // for this path, which is the correct outcome: synthesis itself could not author the file.
        console.error(
          `[planner] enrichCreateFileContent: output for ${step.path} still not a real body, keeping original`
        );
      }
    } catch (err) {
      console.error(`[planner] enrichCreateFileContent failed for ${step.path}: ${err.message}`);
    }
  }

  if (enrichedCount > 0) {
    console.error(`[planner] enrichCreateFileContent: synthesized ${enrichedCount} file body(ies)`);
  }
  return enriched;
}

function buildRepairPrompt(previousRaw, originalPrompt) {
  return `
You previously attempted to follow these instructions:

${originalPrompt}

But you returned invalid or incomplete JSON:

${previousRaw || "(empty)"}

You MUST now respond with a SINGLE valid JSON object that matches this schema:

{
  "planSummary": "short summary",
  "steps": [
    {
      "title": "short step title",
      "description": "one or two sentences",
      "action": "create_file" | "search_replace" | "edit_file" | "delete_file" | "run_command",
      "path": "relative/path.ext or null",
      "content": "file contents if edit/create, or null",
      "command": "shell command if run_command, or null"
    }
  ]
}

Rules:
- The JSON MUST be syntactically valid and parseable.
- You MUST propose at least one actionable step. NEVER produce only "note" steps.
- "create_file": For NEW files. content = the COMPLETE file.
- "search_replace": PREFERRED for EXISTING files. edits = [{search: "verbatim old code from RAG", replace: "new code"}]. search MUST match the file byte-for-byte.
- "edit_file": Only for SMALL existing files (<100 lines). content = the COMPLETE updated file.
- "delete_file": path only, no content needed.
- "run_command": command = shell command string.
- Do NOT output diffs, patches, hunks, or +/- prefixed lines.
- Do not include any text outside the JSON. No markdown fences.
`.trim();
}

function tryParseJson(text) {
  if (!text) return null;
  const trimmed = text.trim();
  const attempts = [trimmed];
  // Strip fences if present
  if (trimmed.startsWith("```")) {
    const fenceStripped = trimmed.replace(/^```[a-zA-Z]*\s*/, "").replace(/```$/, "").trim();
    attempts.push(fenceStripped);
  }
  // Extract first/last brace block
  const braceIdx = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (braceIdx !== -1 && lastBrace !== -1 && lastBrace > braceIdx) {
    attempts.push(trimmed.slice(braceIdx, lastBrace + 1));
  }
  for (const candidate of attempts) {
    try {
      return JSON.parse(candidate);
    } catch {
      // continue
    }
  }
  return null;
}

function renderContextRefs(targets = []) {
  return targets
    .map((t) => {
      const note = t.note ? ` (${t.note})` : "";
      const snippet = t.snippet
        ? `\n  anchor:\n${t.snippet
          .split("\n")
          .map((l) => `    ${l}`)
          .join("\n")}`
        : "";
      return `- ${t.path}${note}${snippet}`;
    })
    .join("\n");
}

function renderEditableTargets(targets = []) {
  const MAX_CONTENT_INLINE = 4000;
  const MAX_SNIPPET_INLINE = 8000;  // Allow more snippets - need full function definitions for search_replace
  const HEAD_LINES = 200;
  const TAIL_LINES = 200;
  return targets
    .map((t) => {
      const summary = t.summary ? `\n  summary: ${t.summary}` : "";
      let content = "";
      if (t.content) {
        if (t.content.length > MAX_CONTENT_INLINE) {
          // Instead of omitting, include head + tail so the LLM sees actual code
          const lines = t.content.split("\n");
          if (lines.length <= HEAD_LINES + TAIL_LINES) {
            // File is long in chars but not lines — include all
            content = `\n  content:\n${t.content
              .split("\n")
              .map((l) => `    ${l}`)
              .join("\n")}`;
          } else {
            const head = lines.slice(0, HEAD_LINES).map((l) => `    ${l}`).join("\n");
            const tail = lines.slice(-TAIL_LINES).map((l) => `    ${l}`).join("\n");
            const omitted = lines.length - HEAD_LINES - TAIL_LINES;
            content = `\n  content (${lines.length} lines, showing first ${HEAD_LINES} + last ${TAIL_LINES}):\n${head}\n    ... (${omitted} lines omitted) ...\n${tail}`;
          }
        } else {
          content = `\n  content:\n${t.content
            .split("\n")
            .map((l) => `    ${l}`)
            .join("\n")}`;
        }
      }
      // Live disk content (authoritative current state — use this for search patterns)
      let liveContentSection = "";
      if (t.liveContent) {
        const lc = t.liveContent;
        const label = lc.source === "line-range"
          ? `LIVE DISK CONTENT — lines ${lc.startLine}–${lc.endLine} of ${lc.totalLines} (verbatim, current)`
          : `LIVE DISK CONTENT — full file, ${lc.totalLines} lines (verbatim, current)`;
        liveContentSection = `\n  ${label}:\n\`\`\`\n${lc.content}\n\`\`\``;
      }

      // Include RAG code snippets for search_replace guidance
      // NOTE: Snippets shown UNINDENTED so LLM can copy verbatim without whitespace mismatch
      let ragSnippetsSection = "";
      if (Array.isArray(t.ragSnippets) && t.ragSnippets.length > 0) {
        const snippetText = t.ragSnippets.join("\n---\n").slice(0, MAX_SNIPPET_INLINE);
        // Show snippets in a code block format to preserve exact whitespace
        const snippetLabel = t.liveContent
          ? "ragSnippets (additional context — prefer LIVE DISK CONTENT above for exact search patterns)"
          : "ragSnippets (COPY VERBATIM for search patterns - exact whitespace matters)";
        ragSnippetsSection = `\n  ${snippetLabel}:\n\`\`\`\n${snippetText}\n\`\`\``;
      }
      return `- ${t.path}${summary}${content}${liveContentSection}${ragSnippetsSection}`;
    })
    .join("\n");
}

/**
 * Extract paths that must use search_replace (never create_file) from full story content.
 * Checks YAML frontmatter op:edit entries and @@SEARCH block section headings.
 * @param {string} content - Full story content including frontmatter
 * @returns {string[]} Array of file paths that must use search_replace
 */
export function extractMustEditPaths(content) {
  if (!content || typeof content !== 'string') return [];
  const paths = new Set();

  // Signal 1: op:edit in YAML frontmatter — scan lines for op:edit and find nearest path:
  const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (fmMatch) {
    const yamlLines = fmMatch[1].split('\n');
    for (let i = 0; i < yamlLines.length; i++) {
      if (!/\bop:\s*["']?edit["']?/i.test(yamlLines[i])) continue;
      // Search outward from i (closest lines first) — finds the path: in the SAME list item
      // rather than a path: from a different item that is farther away
      let found = false;
      for (let dist = 1; dist <= 5 && !found; dist++) {
        for (const j of [i - dist, i + dist]) {
          if (j < 0 || j >= yamlLines.length) continue;
          // Stop at list item boundaries — don't cross into a different item
          if (dist > 1 && /^\s*-\s+/.test(yamlLines[j]) && j !== i) continue;
          const pathMatch = yamlLines[j].match(/\bpath:\s*["']?([^"'\n\s,]+)["']?/);
          if (pathMatch) {
            paths.add(pathMatch[1].trim());
            found = true;
            break;
          }
        }
      }
    }
  }

  // Signal 2: @@SEARCH blocks in story body — track which ### heading they appear under
  const lines = content.split('\n');
  let currentPath = null;
  for (const line of lines) {
    const headerMatch = line.match(/^###\s+(?:Target:\s*)?(.+)/);
    if (headerMatch) {
      currentPath = headerMatch[1].trim();
    } else if (/^@@SEARCH\s*$/.test(line.trim()) && currentPath) {
      paths.add(currentPath);
    }
  }

  return [...paths];
}

export function buildPrompt({
  requirements,
  fullRequirements,
  context,
  editableTargets = [],
  contextualRefs = [],
  expectations,
  concerns = [],
  plannerMode = "full",
  testExemplar = null,
  uncoveredCreatePaths = [],
  mustEditPaths = [],
}) {
  const schema = `
You are the RouteKit planner.
Respond with ONLY a JSON object (no markdown fences, no prose outside JSON):
{
  "planSummary": "short summary",
  "steps": [
    {
      "title": "short step title",
      "description": "one or two sentences",
      "action": "edit_file" | "create_file" | "search_replace" | "delete_file" | "note" | "run_command",
      "path": "relative/path.ext or null",
      "content": "file contents if edit/create, or null",
      "edits": [{ "search": "exact text", "replace": "new text" }] // for search_replace only
      "command": "shell command if run_command, or null"
    }
  ]
}

Actions:
- "create_file": New file with full content in "content" field
- "edit_file": Replace entire existing file with new content (use only for small files or complete rewrites)
- "search_replace": Surgical edits via search/replace pairs (PREFERRED for modifying existing files)
- "delete_file": Remove a file entirely (no content needed, just path)
- "run_command": Shell command execution
- "note": Documentation only, no file changes

Rules for search_replace (PREFERRED for modifying existing files):
- Use "edits" array with objects containing "search" and "replace" strings
- "search" must be an exact string match (not regex)
- Include enough surrounding context in "search" to make it unique in the file
- If the search string appears multiple times, the edit will fail - add more context
- For YAML files: ALWAYS include the parent key/section header in search patterns (e.g., "protected_branches:\\n  - main" not just "- main")
- For repetitive structures: Include 2-3 lines of context above the target to capture unique anchors like section headers or comments
- MULTI-LINE SEARCH for ambiguous patterns: When a single-line "search" string could match more than one location in the file, extend the "search" to span multiple lines including 2–3 surrounding lines that are unique to the target location. Do not use the shortest possible pattern — use enough context lines to be unambiguously unique. Example: instead of "  description TEXT,", use "CREATE TABLE discrepancies (\n  id INTEGER PRIMARY KEY,\n  description TEXT," to pin the exact block.
- Edits are applied in order
- IMPORTANT: If a target shows "(existing file - use search_replace for edits)", you MUST use "search_replace" action, NOT "create_file" or "edit_file"
- CRITICAL: If a targetFile has op="edit" in the story frontmatter, you MUST NEVER emit a "create_file" step for that path. op="edit" means the file ALREADY EXISTS on disk. Always use "search_replace" for op:edit targets. Emitting "create_file" for an op:edit target is a hard error that will cause an infinite retry loop.
- CRITICAL: If "ragSnippets" are provided for a target, use VERBATIM code from those snippets for your "search" patterns. Do NOT guess or invent code patterns - copy exact text from the ragSnippets.
- When ragSnippets are available, your search patterns should match actual code from the snippets exactly
- CRITICAL: Preserve EXACT whitespace (indentation, spacing) when copying from ragSnippets. If the ragSnippet has 2-space indentation, your search pattern must have exactly 2-space indentation.
- DEPENDENT CHAINS NOT ALLOWED: Do NOT create a step where the "search" pattern is code that a PREVIOUS step would create. Each step's search pattern must exist in the CURRENT file. If you need multiple related changes, combine them into a single search_replace with a larger search/replace pair. (e.g., if wrapping a JSX element in a Fragment while relocating a child element: use ONE edit for the opening tag change and ONE edit covering the FULL closing region including the relocated child — never 3 separate edits where a middle edit's REPLACE output becomes a later edit's SEARCH target)
- CREATE FILE MVP RULE: When action is "create_file", the content field MUST contain the complete, final file content. 
  - Do NOT create stub/skeleton files expecting follow-up search_replace steps
  - Do NOT use search_replace on a file path that appears in an earlier create_file step. 
- If the file is too complex to write in one step, return status "needs_refinement" with reason "file_too_complex". Tell the refiner that file decomposition is REQUIRED
- If you need to add new code after an existing line AND modify that line, do it in ONE edit with both the existing and new code in the "replace" field.

Rules for edit_file/create_file:
- SINGLE SOURCE OF TRUTH for shared values: when the same logical value (a design token, constant, config literal, color hex, magic number, enum) must appear in more than one generated file, define it ONCE in a single module and import it into the others — never re-declare or re-derive the same literal independently per file. When two files are required to hold matching values (for example a palette/tokens module and a stylesheet, or a component and its test), the values MUST be byte-identical and traceable to that one source; never re-derive plausible values per file (that silently produces divergent, mismatched values).
- For EVERY step you MUST include concrete, non-empty content. Do NOT return null/empty/placeholder content.
- For edit_file actions, content MUST be the COMPLETE updated file. Do NOT output diffs, patches, hunks, or lines prefixed with + or -. Any diff-style output is invalid.
- AUTHORITATIVE CONTENT RULE: When an Editable Code Target includes a "LIVE DISK CONTENT" block, that block is the AUTHORITATIVE representation of the file's current state on disk. Use it verbatim as the basis for all search_replace patterns and as the ground truth for what the file contains. Story-body code blocks in the Requirements section are STORY INTENT (written at story-creation time and potentially stale) — they describe what to do, not what the file currently contains.
- STORY INTENT vs LIVE CONTENT: If a "### Target:" section in Requirements contains a code block, treat it as the author's intent describing the desired outcome. If the same file has a "LIVE DISK CONTENT" block in Editable Code Targets, the live content overrides the Requirements block as the source of search patterns. Never invent search patterns — always copy from LIVE DISK CONTENT.
- SOURCE BLOCKS ARE INPUT-ONLY: Code blocks under headings that contain the words "source", "reference", "extraction", or "snippet" (case-insensitive), or blocks whose first non-empty line starts with "// Context:", are transformation input material. NEVER use them verbatim as create_file content. They describe what to extract or transform, not what to output. CRITICAL: Transcribe the source logic exactly — same field names, same conditionals, same variable lookups. Do not simplify or reinterpret.
- TARGET + SOURCE SYNTHESIS: When a "### Target: <path>" section provides a function signature but no complete code block, AND labeled source blocks exist with implementation logic (e.g. a useMemo body, a function body), synthesize the complete output file as follows: (1) use the function signature from "### Target:" as the exported function declaration, (2) incorporate the implementation logic from the source block as the function body — stripping any leading "// Context:" prefix lines, (3) add all necessary imports at the top. The output MUST be a complete, valid, importable TypeScript/JavaScript file with proper imports, export keyword, function wrapper, and body — never raw extracted code without a function wrapper.

General rules:
- You MUST propose at least one executable step unless it is truly impossible to change this project.
- If nothing executable is possible, return exactly one "note" step explaining why.
- You may ONLY edit files listed under "Editable Code Targets" below. All other references are read-only.
- Contextual References are read-only; do NOT attempt to edit them.
- No text outside the JSON.`;
  const expectationText = expectations?.length
    ? `\nExpectations:\n${expectations.map((e) => `- ${e}`).join("\n")}`
    : "";
  const fullReq =
    fullRequirements &&
    (!context || context.trim() !== fullRequirements.trim())
      ? `\nFull requirements:\n${fullRequirements}`
      : "";
  const testExemplarSection = testExemplar
    ? `\nTest Exemplar (CRITICAL — follow this pattern for ALL create_file test steps):\nWhen generating test files, you MUST follow the import style, describe/it structure, and assertion patterns shown below. Every it() block MUST contain at least one expect() or assert() call. Empty test bodies will be REJECTED.\n\`\`\`javascript\n${testExemplar}\n\`\`\``
    : "";
  const editableSection = editableTargets.length ? `\nEditable Code Targets:\n${renderEditableTargets(editableTargets)}` : "\nEditable Code Targets:\n- (none)";
  // Detect existing-file targets (have live content on disk) to prevent conflicting create_file mandates
  const existingFilePaths = editableTargets.filter(t => t.liveContent).map(t => t.path).filter(Boolean);
  // neverCreatePaths: union of live-content paths AND mustEditPaths (op:edit / @@SEARCH signal)
  const neverCreatePaths = new Set([...existingFilePaths, ...(Array.isArray(mustEditPaths) ? mustEditPaths : [])]);
  const criticalExistingFileBlock = neverCreatePaths.size
    ? `\nCRITICAL — MUST USE search_replace — create_file IS FORBIDDEN:\nThe following files must NEVER use create_file. You MUST use search_replace for all edits. Emitting create_file for any of these paths is a hard error:\n${[...neverCreatePaths].map(p => `- ${p}`).join('\n')}`
    : "";
  const contextualSection = contextualRefs.length ? `\nContextual References (read-only):\n${renderContextRefs(contextualRefs)}` : "\nContextual References (read-only):\n- (none)";
  const modeLine = `\nPlanner mode: ${plannerMode}`;
  const effectiveContext =
    context && fullRequirements && context.trim() === fullRequirements.trim()
      ? ""
      : (context || "");
  const concernsSection =
    Array.isArray(concerns) && concerns.length
      ? `\nConcerns (optional tagging):\nYou MAY tag steps with concernId matching these concerns to improve coverage reasoning:\n${concerns
          .map((c) => `- ${c.id || "(id)"}: ${c.label || ""}`)
          .join("\n")}`
      : "";
  const clusterNote = `\nNote: The critic will group steps into semanticClusters during analysis; the planner does not need to generate clusters.`;
  const functionScopeNote =
    plannerMode === "function_scope"
      ? `\nFunction-scope mode: You are seeing only a function slice. Return the full updated function definition; do NOT change code outside the slice or add new imports/exports/functions beyond the visible slice.`
      : "";
  const guardrailsNote = `\nGuardrails:\n- All edit_file actions must provide the full updated file content.\n- No diffs/patches/partial edits; do not use +/-, @@, or hunks.\n- Do not modify files outside the listed editable targets.${functionScopeNote}`;
  // Filter neverCreatePaths from uncoveredCreatePaths — mustEdit takes precedence over create mandate
  const filteredUncoveredCreatePaths = Array.isArray(uncoveredCreatePaths)
    ? uncoveredCreatePaths.filter(p => !neverCreatePaths.has(p))
    : [];
  const uncoveredCreateSection = filteredUncoveredCreatePaths.length
    ? `\nREQUIRED CREATE_FILE STEPS — YOU MUST INCLUDE ALL OF THESE:\nThe following files are marked op:create in the story frontmatter but have NO pre-extracted code block. You MUST generate a complete "create_file" step for EACH path listed below. Apply the TARGET+SOURCE SYNTHESIS rule: use the function signature from the ### Target: section as the exported function declaration, incorporate the implementation logic from the labeled source blocks as the function body, and add all necessary imports. Output a complete, valid, importable file — never a stub or skeleton:\n${filteredUncoveredCreatePaths.map(p => `- ${p}`).join('\n')}`
    : "";
  return `${schema}${modeLine}${testExemplarSection}${editableSection}${criticalExistingFileBlock}${contextualSection}${expectationText}\nRequirements:\n${requirements}${fullReq}${concernsSection}${clusterNote}${guardrailsNote}${uncoveredCreateSection}\nContext:\n${effectiveContext || "(none)"}`;
}

function runDecompositionCritic({
  requirements,
  fullRequirements,
  context,
  editableTargets = [],
  contextualRefs = [],
  plannerMode,
  plan,
}) {
  const issues = [];
  const steps = Array.isArray(plan?.actions) ? plan.actions : [];
  const hasSteps = steps.length > 0;

  const editablePaths = new Set(
    Array.isArray(editableTargets)
      ? editableTargets
        .map((t) => t && t.path)
        .filter((p) => typeof p === "string" && p.length > 0)
      : []
  );

  const isEditOrCreate = (action) => action === "edit_file" || action === "create_file";

  if (!plan || plan.status === "error") {
    issues.push({
      code: "PLAN_ERROR_STATUS",
      severity: "error",
      message: "Planner returned status 'error'.",
      stepIds: [],
    });
  }

  if (!hasSteps) {
    issues.push({
      code: "NO_STEPS",
      severity: "error",
      message: "Planner returned no steps.",
      stepIds: [],
    });
  }

  steps.forEach((step) => {
    const action = step.action || "note";
    const stepId = step.id || null;
    const path = step.path || null;
    const content =
      typeof step.content === "string" ? step.content : step.content ?? "";

    if (isEditOrCreate(action)) {
      if (!path) {
        issues.push({
          code: "MISSING_PATH",
          severity: "error",
          message: "edit_file/create_file step is missing a path.",
          stepIds: stepId ? [stepId] : [],
        });
      } else if (editablePaths.size > 0 && !editablePaths.has(path)) {
        issues.push({
          code: "ILLEGAL_PATH",
          severity: "error",
          message: `Step attempts to modify a path that is not in editable targets: ${path}`,
          stepIds: stepId ? [stepId] : [],
        });
      }

      if (!content || !String(content).trim()) {
        issues.push({
          code: "MISSING_CONTENT",
          severity: "error",
          message: "edit_file/create_file step is missing concrete, non-empty content.",
          stepIds: stepId ? [stepId] : [],
        });
      }
    }

    if (action === "run_command") {
      if (!step.command || !String(step.command).trim()) {
        issues.push({
          code: "MISSING_COMMAND",
          severity: "warning",
          message: "run_command step has no concrete command.",
          stepIds: stepId ? [stepId] : [],
        });
      }
    }
  });

  const requirementTextRaw =
    typeof fullRequirements === "string" && fullRequirements.trim().length > 0
      ? fullRequirements
      : typeof requirements === "string"
        ? requirements
        : "";
  const requirementText = requirementTextRaw.trim();
  const requirementLength = requirementText.length;

  const executableSteps = steps.filter((s) => isEditOrCreate(s.action));
  if (plan && plan.status === "note_only" && !plan.hasExecutableWithContent) {
    issues.push({
      code: "NON_EXECUTABLE_PLAN",
      severity: "warning",
      message: "Plan contains only note steps and no executable edits.",
      stepIds: [],
    });
  } else if (plan && plan.status === "executable" && plan.hasExecutableWithContent) {
    if (executableSteps.length <= 1 && requirementLength > 300) {
      issues.push({
        code: "UNDER_DECOMPOSED",
        severity: "warning",
        message: "Complex requirements but only a single executable step was produced.",
        stepIds: executableSteps.map((s) => s.id).filter(Boolean),
      });
    }

    // Special-case heuristic for CLI project attach story:
    // If the requirements mention "project attach" but the plan only edits the CLI entry file,
    // and that edit does NOT appear to define an attach handler, treat this as under-decomposed.
    const reqLower = requirementText.toLowerCase();
    if (reqLower.includes("project attach")) {
      const execPaths = executableSteps
        .map((s) => s.path)
        .filter((p) => typeof p === "string" && p.length > 0);
      const uniqueExecPaths = new Set(execPaths);
      if (uniqueExecPaths.size === 1 && uniqueExecPaths.has("packages/cli/bin/routekit.js")) {
        const cliSteps = executableSteps.filter(
          (s) => s.path === "packages/cli/bin/routekit.js" && typeof s.content === "string"
        );
        const cliContentLower = cliSteps
          .map((s) => s.content || "")
          .join("\n")
          .toLowerCase();

        const hasAttachHandler =
          cliContentLower.includes("handleprojectattach") ||
          cliContentLower.includes("function handleprojectattach") ||
          cliContentLower.includes("project attach requires --id");

        if (!hasAttachHandler) {
          issues.push({
            code: "UNDER_DECOMPOSED",
            severity: "warning",
            message:
              "Requirements mention project attach behavior, but the plan appears to only update CLI usage/help text without defining an attach handler. Add additional steps to implement attach routing and behavior.",
            stepIds: executableSteps.map((s) => s.id).filter(Boolean),
          });
        }
      }
    }
  }

  // CREATE_FILE_CHAIN detection: create_file followed by search_replace on same path
  const createFilePaths = new Set();
  for (const step of steps) {
    if (step.action === "create_file" && step.path) {
      createFilePaths.add(step.path);
    }
  }
  for (const step of steps) {
    if (step.action === "search_replace" && step.path && createFilePaths.has(step.path)) {
      issues.push({
        code: "CREATE_FILE_CHAIN",
        severity: "error",
        message: `search_replace targets path "${step.path}" which was created by an earlier create_file step. CREATE FILE content must be complete - do not chain search_replace after create_file.`,
        stepIds: step.id ? [step.id] : [],
      });
    }
  }

  // Action clustering by file path: detect many edits to the same file that might be merged.
  const pathClusters = new Map();
  for (const step of steps) {
    const p = step.path;
    if (!p || typeof p !== "string") continue;
    if (!pathClusters.has(p)) pathClusters.set(p, []);
    pathClusters.get(p).push(step);
  }

  for (const [p, clusteredSteps] of pathClusters.entries()) {
    const fileExecCount = clusteredSteps.filter((s) => isEditOrCreate(s.action)).length;
    if (fileExecCount >= 3) {
      issues.push({
        code: "MULTIPLE_STEPS_SAME_FILE",
        severity: "info",
        message: `There are ${fileExecCount} edit/create steps for the same file (${p}). Consider whether these can be merged into fewer full-file updates.`,
        stepIds: clusteredSteps.map((s) => s.id).filter(Boolean),
      });
    }
  }

  // Required sequencing detection: run_command steps that appear before edits are suspicious.
  const execOrders = executableSteps
    .map((s) => (typeof s.order === "number" ? s.order : Number(s.order) || 0))
    .filter((n) => Number.isFinite(n));
  const runCommandSteps = steps.filter((s) => s.action === "run_command");
  const runOrders = runCommandSteps
    .map((s) => (typeof s.order === "number" ? s.order : Number(s.order) || 0))
    .filter((n) => Number.isFinite(n));

  if (execOrders.length && runOrders.length) {
    const minExecOrder = Math.min(...execOrders);
    const badRunSteps = runCommandSteps.filter((s) => {
      const ord = typeof s.order === "number" ? s.order : Number(s.order) || 0;
      return ord > 0 && ord < minExecOrder;
    });
    if (badRunSteps.length) {
      issues.push({
        code: "RUN_COMMAND_BEFORE_EDIT",
        severity: "warning",
        message:
          "Some run_command steps are ordered before edit/create steps. Typically commands such as tests or builds should run after code edits.",
        stepIds: badRunSteps.map((s) => s.id).filter(Boolean),
      });
    }
  }

  // Semantic decomposition / diff-scope inference: long requirements but a single-file, single-step plan.
  if (requirementLength > 500) {
    const uniqueExecPaths = new Set(
      executableSteps
        .map((s) => s.path)
        .filter((p) => typeof p === "string" && p.length > 0)
    );
    if (uniqueExecPaths.size === 1 && executableSteps.length === 1) {
      issues.push({
        code: "MONOLITHIC_SINGLE_FILE_PLAN",
        severity: "info",
        message:
          "Long, multi-part requirements but the plan changes only one file in a single step. This may be acceptable, but consider whether additional files or steps should participate.",
        stepIds: executableSteps.map((s) => s.id).filter(Boolean),
      });
    }
  }

  const { clusters = [], note: clusterNote = null } = computeSemanticClusters(steps);
  const concerns = Array.isArray(plan?.critic?.concerns) ? plan.critic.concerns : [];

  if (concerns.length) {
    const concernCounts = {};
    concerns.forEach((c) => {
      if (!c?.id) return;
      concernCounts[c.id] = 0;
    });

    const mapStepToConcern = (step) => {
      if (!step || typeof step !== "object") return null;
      if (step.concernId) return step.concernId;
      if (step.meta && step.meta.concernId) return step.meta.concernId;
      // fallback heuristic: match by label substring
      const title = (step.title || step.description || "").toLowerCase();
      for (const c of concerns) {
        if (!c?.id || !c?.label) continue;
        if (title.includes(String(c.label).toLowerCase())) return c.id;
      }
      return null;
    };

    const unmappedSteps = [];
    steps.forEach((s) => {
      const cid = mapStepToConcern(s);
      if (cid && concernCounts[cid] !== undefined) {
        concernCounts[cid] += 1;
      } else {
        unmappedSteps.push(s.id || null);
      }
    });

    Object.entries(concernCounts).forEach(([cid, count]) => {
      if (count === 0) {
        issues.push({
          code: "UNMAPPED_CONCERN",
          severity: "info",
          message: `Concern ${cid} has no mapped steps.`,
          stepIds: [],
        });
      }
    });

    if (unmappedSteps.length) {
      issues.push({
        code: "UNMAPPED_STEPS",
        severity: "info",
        message: "Some steps are not mapped to any concern.",
        stepIds: unmappedSteps.filter(Boolean),
      });
    }
  }

  let highestSeverity = "info";
  for (const issue of issues) {
    if (issue.severity === "error") {
      highestSeverity = "error";
      break;
    }
    if (issue.severity === "warning" && highestSeverity === "info") {
      highestSeverity = "warning";
    }
  }

  let riskLevel = "low";
  if (highestSeverity === "warning") riskLevel = "medium";
  if (highestSeverity === "error") riskLevel = "high";

  let confidence = 0.8;
  if (highestSeverity === "warning") confidence -= 0.2;
  if (highestSeverity === "error") confidence -= 0.4;
  if (confidence < 0.1) confidence = 0.1;
  if (confidence > 0.99) confidence = 0.99;

  let overallVerdict = "accept";
  if (!plan || plan.status === "error") {
    overallVerdict = "reject_human_review";
  } else if (highestSeverity === "error") {
    overallVerdict = "revise_with_new_prompt";
  } else if (highestSeverity === "warning") {
    overallVerdict = "revise_with_same_prompt";
  }

  const suggestedFixesSet = new Set();
  for (const issue of issues) {
    switch (issue.code) {
      case "MISSING_PATH":
      case "ILLEGAL_PATH":
        suggestedFixesSet.add(
          "Ensure all edit_file/create_file steps target only the allowed editable code targets and include a valid path."
        );
        break;
      case "MISSING_CONTENT":
        suggestedFixesSet.add(
          "Provide complete, non-empty file content for every edit_file/create_file step (no placeholders)."
        );
        break;
      case "MISSING_COMMAND":
        suggestedFixesSet.add(
          "Either remove run_command steps without commands or provide concrete shell commands."
        );
        break;
      case "NON_EXECUTABLE_PLAN":
        suggestedFixesSet.add(
          "Add at least one concrete edit_file/create_file step so the plan can actually change the project."
        );
        break;
      case "UNDER_DECOMPOSED":
        suggestedFixesSet.add(
          "Break the work into multiple smaller, ordered edit_file steps instead of a single large one."
        );
        break;
      case "NO_STEPS":
        suggestedFixesSet.add(
          "Return at least one step that either explains why no change is possible or performs a concrete edit."
        );
        break;
      case "PLAN_ERROR_STATUS":
        suggestedFixesSet.add(
          "Ensure the planner always returns syntactically valid JSON with a non-error status."
        );
        break;
      case "MULTIPLE_STEPS_SAME_FILE":
        suggestedFixesSet.add(
          "Consider merging multiple edit_file/create_file steps for the same file into fewer full-file updates to keep the plan simpler and easier to apply."
        );
        break;
      case "RUN_COMMAND_BEFORE_EDIT":
        suggestedFixesSet.add(
          "Ensure run_command steps that run tests, builds, or tooling come after the relevant edit_file/create_file steps so they operate on the updated code."
        );
        break;
      case "MONOLITHIC_SINGLE_FILE_PLAN":
        suggestedFixesSet.add(
          "For long, multi-part requirements, consider decomposing work into multiple steps or touching additional files when appropriate instead of a single monolithic change."
        );
        break;
      default:
        break;
    }
  }

  const suggestedFixes = Array.from(suggestedFixesSet);

  let suggestedRetryPromptSuffix = null;
  if (suggestedFixes.length) {
    suggestedRetryPromptSuffix = `Please adjust your plan with the following guidance:\n- ${suggestedFixes.join(
      "\n- "
    )}`;
  }

  return {
    overallVerdict,
    riskLevel,
    confidence,
    issues,
    suggestedFixes,
    suggestedPlannerMode: plannerMode || null,
    suggestedRetryPromptSuffix,
    semanticClusters: clusters,
    ...(clusterNote ? { semanticClustersNote: clusterNote } : {}),
    _stepsExamined: steps.length,
    concerns,
  };
}

export async function runLlmPlanner({
  requirements,
  fullRequirements,
  context,
  editableTargets = [],
  contextualRefs = [],
  runFolder,
  useReplay = true,
  plannerMode = "full",
  testExemplar = null,
  uncoveredCreatePaths = [],
  mustEditPaths = [],
  llmContext = {},
}) {
  // Allow explicit skip for testing/CI
  if (process.env.RKS_SKIP_LLM === "1") {
    console.error("[planner] RKS_SKIP_LLM=1, skipping LLM call");
    return null;
  }
  const env = loadEnv();
  if (!env.openaiKey && !env.anthropicKey) {
    return {
      prompt: null,
      raw: null,
      planSummary: null,
      actions: [],
      status: "error",
      error: "no_api_key",
      errorMessage: "No API key configured. Set OPENAI_API_KEY or ANTHROPIC_API_KEY in .env",
      hasExecutableWithContent: false,
    };
  }
  const concernInfo = runConcernDecompositionPass(requirements || fullRequirements || "");
  const plannerModeEnv = process.env.RKS_PLANNER_MODE || plannerMode || "full";
  const refinementFlag = process.env.RKS_PLANNER_REFINEMENT;
  const refinementEnabled = refinementFlag ? !(refinementFlag === "off" || refinementFlag === "0") : true;

  const markdownSource = (fullRequirements && fullRequirements.trim()) || requirements || "";
  const markdownTargets = parseTargetsFromMarkdown(markdownSource);
  const existingTargetPaths = (editableTargets || []).map((t) => t.path).filter(Boolean);
  const mergedTargetPaths = Array.from(new Set([...existingTargetPaths, ...markdownTargets]));

  let effectiveEditableTargets = editableTargets;
  // Preserve ragSnippets from passed-in targets (they may have been enhanced)
  const ragSnippetsByPath = new Map();
  (editableTargets || []).forEach((t) => {
    if (t.path && t.ragSnippets) {
      ragSnippetsByPath.set(t.path, t.ragSnippets);
    }
  });

  if (runFolder && mergedTargetPaths.length) {
    // runFolder is like: projectRoot/.rks/runs/timestamp_slug
    // Go up 3 levels to get back to projectRoot
    const projectRoot = path.resolve(runFolder, "..", "..", "..");
    try {
      effectiveEditableTargets = loadEditableTargets(projectRoot, mergedTargetPaths, { plannerMode });
      // Add non-existent paths as create_file candidates
      // Check file existence before classifying - files that exist but weren't loaded should use search_replace
      const existingPaths = new Set(effectiveEditableTargets.map((t) => t.path));
      const createTargets = mergedTargetPaths
        .filter((p) => !existingPaths.has(p) && !looksLikeGlob(p))
        .map((p) => {
          const abs = path.join(projectRoot, p);
          if (fs.existsSync(abs)) {
            // File exists but wasn't loaded (too large, encoding issue, etc.)
            // Mark as existing so LLM uses search_replace instead of create_file
            return { path: p, summary: "(existing file - use search_replace for edits)", content: "" };
          }
          return { path: p, summary: "(new file - to be created)", content: "" };
        });
      effectiveEditableTargets = [...effectiveEditableTargets, ...createTargets];

      // Merge back the ragSnippets from the original enhanced targets
      effectiveEditableTargets = effectiveEditableTargets.map((t) => {
        const snippets = ragSnippetsByPath.get(t.path);
        if (snippets) {
          return {
            ...t,
            ragSnippets: snippets,
            summary: t.summary
              ? `${t.summary} (has ${snippets.length} RAG snippets for search_replace)`
              : `(has ${snippets.length} RAG snippets for search_replace)`,
          };
        }
        return t;
      });
    } catch {
      effectiveEditableTargets = editableTargets;
    }
  }

  // Seed create_file test targets with exemplar content so the LLM
  // uses search_replace to adjust rather than generating from scratch.
  // LLMs reliably edit existing content but struggle to generate large
  // content strings for create_file steps (empty test bodies).
  const testFilePatterns = ['.test.', '.spec.', '__tests__'];
  if (testExemplar) {
    effectiveEditableTargets = effectiveEditableTargets.map((t) => {
      const isNewTest = t.summary?.includes("new file") &&
        testFilePatterns.some(p => t.path?.includes(p));
      if (isNewTest) {
        return {
          ...t,
          content: testExemplar,
          summary: "(new test file - seed content provided, adjust for story requirements using search_replace)",
        };
      }
      return t;
    });
  }

  // Compute mustEditPaths from fullRequirements (includes frontmatter op:edit and @@SEARCH blocks)
  // Merge with any explicitly passed-in mustEditPaths
  const derivedMustEditPaths = extractMustEditPaths(fullRequirements || requirements || '');
  const effectiveMustEditPaths = [...new Set([...mustEditPaths, ...derivedMustEditPaths])];

  const runSinglePassPlanner = async ({
    requirements: req,
    fullRequirements: fullReq,
    context: ctx,
    editableTargets: edTargets,
    contextualRefs: ctxRefs,
    runFolder: folder,
    useReplay: replayFlag,
    plannerMode: mode,
      concernInfo: cInfo,
      refinementEnabled: refineEnabled,
      testExemplar: exemplar,
      uncoveredCreatePaths: createPaths,
      mustEditPaths: editPaths,
    }) => {
    const prompt = buildPrompt({
      requirements: req,
      fullRequirements: fullReq,
      context: ctx,
      editableTargets: edTargets,
      contextualRefs: ctxRefs,
      plannerMode: mode,
      concerns: cInfo?.concerns || [],
      testExemplar: exemplar,
      uncoveredCreatePaths: createPaths,
      mustEditPaths: editPaths,
    });
    console.error("[planner] prompt length (chars):", prompt.length);
    if (replayFlag) {
      const cached = maybeReadReplay(folder);
      if (cached?.actions) return cached;
    }

    const callOnce = async (inputPrompt) => {
      let raw = "";
      let llmUsage = null;
      try {
        console.error("[planner] callOnce start");
        const timeoutMs = DEFAULT_LLM_TIMEOUT_MS;
        let timeoutHandle = null;
        const withTimeout = (promise) =>
          Promise.race([
            promise,
            new Promise((_, reject) => {
              timeoutHandle = setTimeout(
                () => reject(new Error(`LLM request timed out after ${timeoutMs}ms`)),
                timeoutMs
              );
            }),
          ]);

        if (env.provider === "openai") {
          const client = createOpenAiClient(env);
          if (!client) throw new Error("OpenAI client not configured");
          const controller = new AbortController();
          const llmPromise = callOpenAiChat({
            client,
            model: env.model,
            prompt: inputPrompt,
            signal: controller.signal,
            systemPrompt: PLANNER_SYSTEM_PROMPT,
          }).finally(() => {
            controller.abort();
          });
          raw = await withTimeout(llmPromise);
          clearTimeout(timeoutHandle);
        } else if (env.provider === "anthropic") {
          const client = createAnthropicClient(env);
          if (!client) throw new Error("Anthropic client not configured");
          const controller = new AbortController();
          const llmPromise = callAnthropicChatWithUsage({
            client,
            model: env.model,
            prompt: inputPrompt,
            signal: controller.signal,
            systemPrompt: PLANNER_SYSTEM_PROMPT,
            context: llmContext,
          }).finally(() => {
            controller.abort();
          });
          const llmCallResult = await withTimeout(llmPromise);
          raw = llmCallResult.content;
          llmUsage = llmCallResult.usage;
          clearTimeout(timeoutHandle);
        } else {
          throw new Error(`Unsupported provider: ${env.provider}`);
        }
        const parsed = parsePlannerJson(raw);
        if (parsed) {
          const normalized = normalizePlannerSteps(Array.isArray(parsed.steps) ? parsed.steps : []);
          const status = classifyPlan({
            parsed,
            hasExecutableWithContent: normalized.hasExecutableWithContent,
            diffRejected: normalized.diffRejected,
          });
          return {
            prompt: inputPrompt,
            raw,
            planSummary: parsed.planSummary || null,
            actions: normalized.steps,
            status,
            error: null,
            hasExecutableWithContent: normalized.hasExecutableWithContent,
            usage: llmUsage,
          };
        }
        return {
          prompt: inputPrompt,
          raw,
          planSummary: null,
          actions: [],
          status: "error",
          error: raw && raw.trim().length ? "parse failed" : "raw empty",
          hasExecutableWithContent: false,
          usage: llmUsage,
        };
      } catch (error) {
        const msg =
          error?.name === "AbortError" && error?.message.includes("timed out")
            ? error.message
            : error?.message || String(error);
        return {
          prompt: inputPrompt,
          raw: raw || null,
          planSummary: null,
          actions: [],
          status: "error",
          error: msg,
          hasExecutableWithContent: false,
          usage: llmUsage,
        };
      } finally {
        console.error("[planner] callOnce end");
      }
    };

    // backlog.fix.planner-greenfield-body-synthesis: synthesize real bodies for any create_file
    // step the JSON planner narrated instead of authoring, BEFORE anything judges this plan. The
    // critic, statusNeedsRetry, and the server's create-coverage gate all read `status` /
    // `hasExecutableWithContent`, so synthesis has to land upstream of all three — otherwise a
    // greenfield plan is condemned as note_only and sent around a repair loop that cannot fix it,
    // because the LLM cannot emit a whole file body through the JSON channel no matter how many
    // times it is asked. Status is recomputed from the enriched actions.
    const withSynthesizedBodies = async (planResult) => {
      if (!planResult || planResult.status === "error") return planResult;
      if (!planResult.actions?.length) return planResult;
      const actions = await enrichCreateFileContent({
        actions: planResult.actions,
        requirements: fullReq || req || "",
        env,
        llmContext,
      });
      if (actions === planResult.actions) return planResult;
      const hasExec = computeHasExecutableWithContent(actions);
      return {
        ...planResult,
        actions,
        hasExecutableWithContent: hasExec,
        // status !== "error" here implies parsed && !diffRejected, so classifyPlan reduces to the
        // executable/note_only split on the recomputed flag.
        status: classifyPlan({ parsed: true, hasExecutableWithContent: hasExec, diffRejected: false }),
      };
    };

    const first = await withSynthesizedBodies(await callOnce(prompt));
    const firstCritic = runDecompositionCritic({
      requirements: req,
      fullRequirements: fullReq,
      context: ctx,
      editableTargets: edTargets,
      contextualRefs: ctxRefs,
      plannerMode: mode,
      plan: first,
    });
    if (cInfo) {
      firstCritic.concerns = cInfo.concerns || [];
      if (cInfo.rationale) firstCritic.concernsRationale = cInfo.rationale;
    }
    const attempts = [
      { status: first.status, error: first.error, raw: first.raw, critic: { ...firstCritic, refinementMode: "initial" } },
    ];

    const statusNeedsRetry =
      first.status === "error" ||
      (first.status === "note_only" && !first.hasExecutableWithContent);
    const criticWantsRetry =
      firstCritic.overallVerdict === "revise_with_same_prompt" ||
      firstCritic.overallVerdict === "revise_with_new_prompt";
    const refinementAllowed = refineEnabled && criticWantsRetry;

      if (!statusNeedsRetry && !refinementAllowed) {
      const payload = {
        ...first,
        critic: firstCritic,
        attempts,
        meta: mergeMeta(first.meta, {
          plannerAttempts: attempts.length,
          refinementUsed: false,
          plannerMode: mode,
          promptLength: prompt.length,
        }),
      };
      if (folder) writeReplay(folder, payload);
      return payload;
    }

    let secondPrompt;
    let secondMode = null;
    if (statusNeedsRetry) {
      secondPrompt = buildRepairPrompt(first.raw, prompt);
      secondMode = "repair";
    } else {
      const extraRaw = (firstCritic.suggestedRetryPromptSuffix || "").trim();
      if (!extraRaw) {
        const payload = {
          ...first,
          critic: firstCritic,
          attempts,
          meta: mergeMeta(first.meta, {
            plannerAttempts: attempts.length,
            refinementUsed: false,
            plannerMode: mode,
            promptLength: prompt.length,
          }),
        };
        if (folder) writeReplay(folder, payload);
        return payload;
      }
      const extra = extraRaw.length > 1000 ? `${extraRaw.slice(0, 1000)}…` : extraRaw;
      secondPrompt = `${prompt}\n\n${extra}`;
      secondMode = "refinement";
    }

    const second = await withSynthesizedBodies(await callOnce(secondPrompt));
    const secondCritic = runDecompositionCritic({
      requirements: req,
      fullRequirements: fullReq,
      context: ctx,
      editableTargets: edTargets,
      contextualRefs: ctxRefs,
      plannerMode: mode,
      plan: second,
    });
    if (cInfo) {
      secondCritic.concerns = cInfo.concerns || [];
      if (cInfo.rationale) secondCritic.concernsRationale = cInfo.rationale;
    }
    const allAttempts = [
      ...attempts,
      { status: second.status, error: second.error, raw: second.raw, critic: { ...secondCritic, refinementMode: secondMode || "refinement" } },
    ];

    let mainPlan = second;
    let mainCritic = secondCritic;

    if (second.status === "error" && !statusNeedsRetry && first.status !== "error") {
      mainPlan = first;
      mainCritic = firstCritic;
    }

    const usedSecond =
      second.status !== "error" &&
      (second.status === "executable" || (!first.hasExecutableWithContent && second.hasExecutableWithContent));

    if (!usedSecond) {
      mainPlan = first;
      mainCritic = firstCritic;
    }

    const finalPayload = {
      ...mainPlan,
      prompt,
      critic: mainCritic,
      attempts: allAttempts,
      meta: mergeMeta(mainPlan.meta, {
        plannerAttempts: allAttempts.length,
        refinementUsed: secondMode === "refinement",
        plannerMode: mode,
        promptLength: (prompt || "").length,
      }),
    };
    if (folder) writeReplay(folder, finalPayload);
    return finalPayload;
  };

  const concerns = concernInfo.concerns || [];
  const enableMultiConcern = plannerModeEnv === "multi_concern" && concerns.length > 0;

  if (!enableMultiConcern) {
    const result = await runSinglePassPlanner({
      requirements,
      fullRequirements,
      context,
      editableTargets: effectiveEditableTargets,
      contextualRefs,
      runFolder,
      useReplay,
      plannerMode,
      concernInfo,
      refinementEnabled,
      testExemplar,
      uncoveredCreatePaths,
      mustEditPaths: effectiveMustEditPaths,
    });

    // Post-plan test generation: enrich empty test files with focused LLM call
    if (testExemplar && result?.actions?.length) {
      result.actions = await enrichTestFileContent({
        actions: result.actions,
        testExemplar,
        requirements: requirements || fullRequirements || "",
        env,
        llmContext,
      });
      // Re-save replay with enriched content
      if (runFolder) writeReplay(runFolder, result);
    }

    return result;
  }

  const concernResults = [];
  for (const concern of concerns) {
    const concernReq = `${concern.label || concern.id}\n${concern.desc || ""}`.trim() || requirements;
    const res = await runSinglePassPlanner({
      requirements: concernReq,
      fullRequirements,
      context,
      editableTargets: effectiveEditableTargets,
      contextualRefs,
      runFolder: null,
      useReplay: false,
      plannerMode,
      concernInfo,
      refinementEnabled,
      testExemplar,
      uncoveredCreatePaths,
      mustEditPaths: effectiveMustEditPaths,
    });
    const actionsWithConcern = (res.actions || []).map((a) => ({
      ...a,
      concernId: concern.id,
      ...(a.meta ? { meta: { ...a.meta, concernId: concern.id } } : { meta: { concernId: concern.id } }),
    }));
    const attemptsWithConcern = (res.attempts || []).map((att) => ({
      ...att,
      critic: {
        ...(att.critic || {}),
        concerns: concernInfo.concerns || [],
        primaryConcernId: concern.id,
      },
    }));
    concernResults.push({
      concern,
      res: { ...res, actions: actionsWithConcern, attempts: attemptsWithConcern },
    });
  }

  let mergedActions = concernResults.flatMap((cr) => cr.res.actions || []);
  const mergedAttempts = concernResults.flatMap((cr) => cr.res.attempts || []);
  const mergedIssues = concernResults.flatMap((cr) => cr.res.critic?.issues || []);
  const mergedClusters = concernResults.flatMap((cr) => cr.res.critic?.semanticClusters || []);

  // Post-plan test generation: enrich empty test files with focused LLM call
  if (testExemplar && mergedActions.length) {
    mergedActions = await enrichTestFileContent({
      actions: mergedActions,
      testExemplar,
      requirements: requirements || fullRequirements || "",
      env,
      llmContext,
    });
  }

  // Same shared predicate as the single-pass path (see hasExecutableWithContent above) — the
  // multi-concern merge must not use a looser rule than the coverage gate that judges its output.
  const hasExecutable = mergedActions.some(
    (s) =>
      (s.action === "edit_file" || s.action === "create_file") &&
      isSynthesizedBody(s.content, s.path)
  );

  const baseCritic = concernResults[0]?.res?.critic || {};
  const finalCritic = {
    ...baseCritic,
    concerns: concernInfo.concerns || baseCritic.concerns || [],
    ...(concernInfo.rationale ? { concernsRationale: concernInfo.rationale } : {}),
    issues: mergedIssues.length ? mergedIssues : baseCritic.issues || [],
    semanticClusters: mergedClusters.length ? mergedClusters : baseCritic.semanticClusters || [],
    multiPassMode: true,
  };

  const plannerAttemptsCount = concernResults.reduce((sum, cr) => sum + (cr.res.attempts?.length || 0), 0);
  const refinementUsed = concernResults.some((cr) =>
    (cr.res.attempts || []).some((att) => att?.critic?.refinementMode === "refinement")
  );

  const finalPayload = {
    prompt: concernResults[concernResults.length - 1]?.res?.prompt || null,
    raw: null,
    planSummary: concernResults[0]?.res?.planSummary || null,
    actions: mergedActions,
    status: hasExecutable ? "executable" : "note_only",
    error: null,
    hasExecutableWithContent: hasExecutable,
    critic: finalCritic,
    attempts: mergedAttempts,
    meta: mergeMeta(
      mergedAttempts[0]?.meta || {},
      {
        plannerAttempts: plannerAttemptsCount || mergedAttempts.length || 1,
        refinementUsed,
        plannerMode: plannerModeEnv,
        promptLength: (concernResults[concernResults.length - 1]?.res?.prompt || "").length,
      }
    ),
  };

  if (runFolder) writeReplay(runFolder, finalPayload);
  return finalPayload;
}
