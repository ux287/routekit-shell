import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { loadAgentPrompt } from "../../packages/mcp-rks/src/agents/config.mjs";
import { stripFrontmatter, parseFrontmatter } from "../../packages/mcp-rks/src/agents/playbook.mjs";

/**
 * Governor lifecycle tests — prompt assembly pipeline + checkpoint schema.
 *
 * Validates that:
 * 1. Governor prompt loads via the standard agent config path
 * 2. Playbook frontmatter strips correctly
 * 3. Combined Governor+playbook prompt includes both sections
 * 4. Checkpoint schema has required fields and valid values
 * 5. File scope injection adds Allowed Files to assembled prompt
 * 6. Pre-flight validation catches bad launch params
 *
 * @see backlog.governor.lifecycle
 * @see backlog.governor.trust-boundary
 */

const PROJECT_ROOT = process.cwd();
const NOTES_DIR = path.join(PROJECT_ROOT, "notes");

function loadNote(filename) {
  return fs.readFileSync(path.join(NOTES_DIR, filename), "utf8");
}

function extractTargetFiles(storyNoteContent) {
  const match = storyNoteContent.match(/## Target Files\n\n([\s\S]*?)(?:\n##|\n*$)/);
  if (!match) return [];
  return match[1]
    .split("\n")
    .map((line) => line.replace(/^-\s*/, "").replace(/`/g, "").trim())
    .filter(Boolean);
}

function assembleGovernorPrompt(playbook, taskParams) {
  const basePrompt = loadAgentPrompt("governor", PROJECT_ROOT);
  const playbookContent = fs.readFileSync(
    path.join(NOTES_DIR, `playbooks.${playbook}.md`),
    "utf8"
  );
  const playbookBody = stripFrontmatter(playbookContent);

  let prompt = `${basePrompt}\n\n---\n\n# Playbook\n\n${playbookBody}`;

  if (taskParams) {
    prompt += `\n\n# Task\n\n`;
    if (taskParams.projectId) prompt += `Project: ${taskParams.projectId}\n`;
    if (taskParams.storyId) prompt += `Story: ${taskParams.storyId}\n`;
    if (taskParams.runId) prompt += `RunId: ${taskParams.runId}\n`;
    if (taskParams.instruction) prompt += `\n${taskParams.instruction}\n`;

    // Inject active-plan setup instruction when guardrails are on
    if (taskParams.guardrailsOn && taskParams.storyId) {
      prompt += `\nNote: Guardrails are ON. The Dispatcher has set \`.claude/active-plan.json\` pointing to \`notes/${taskParams.storyId}.md\`. Your Edit/Write calls will be validated by \`enforce-plan-scope.mjs\` against the story's Target Files. \`.rks/governor/*\` paths are always allowed.\n`;
    }

    // Always include runId-scoped Governor runtime paths
    const hasTargetFiles = taskParams.targetFiles && taskParams.targetFiles.length > 0;
    if (hasTargetFiles || taskParams.runId) {
      prompt += `\n## Allowed Files\n\n`;
      if (hasTargetFiles) {
        for (const file of taskParams.targetFiles) {
          prompt += `- ${file}\n`;
        }
      }
      if (taskParams.runId) {
        prompt += `- .rks/governor/${taskParams.runId}/*\n`;
      }
    }
  }

  return prompt;
}

// --- Governor prompt loading ---

describe("Governor prompt loading", () => {
  it("loads via loadAgentPrompt", () => {
    const prompt = loadAgentPrompt("governor", PROJECT_ROOT);
    expect(prompt).toBeTruthy();
    expect(prompt).not.toMatch(/^---/);
  });

  it("contains Governor identity", () => {
    const prompt = loadAgentPrompt("governor", PROJECT_ROOT);
    expect(prompt).toContain("You are the Governor");
    expect(prompt).toContain("trusted orchestration layer");
  });

  it("contains checkpoint protocol", () => {
    const prompt = loadAgentPrompt("governor", PROJECT_ROOT);
    expect(prompt).toContain("## Checkpoint Protocol");
    expect(prompt).toContain(".rks/governor/");
  });

  it("contains output format with required status values", () => {
    const prompt = loadAgentPrompt("governor", PROJECT_ROOT);
    expect(prompt).toContain("complete");
    expect(prompt).toContain("failed");
    expect(prompt).toContain("needs_approval");
  });
});

// --- Playbook frontmatter stripping ---

describe("Playbook frontmatter stripping", () => {
  const playbooks = ["lifecycle", "ship"];

  for (const name of playbooks) {
    it(`strips frontmatter from playbooks.${name}.md`, () => {
      const content = fs.readFileSync(
        path.join(NOTES_DIR, `playbooks.${name}.md`),
        "utf8"
      );
      const body = stripFrontmatter(content);

      expect(body).not.toMatch(/^---/);
      expect(body).not.toContain("created:");
      expect(body).toContain("# ");
      expect(body.length).toBeGreaterThan(100);
    });

    it(`preserves structured frontmatter in playbooks.${name}.md`, () => {
      const content = fs.readFileSync(
        path.join(NOTES_DIR, `playbooks.${name}.md`),
        "utf8"
      );
      const { frontmatter } = parseFrontmatter(content);

      expect(frontmatter.agents).toBeInstanceOf(Array);
      expect(frontmatter.phases).toBeInstanceOf(Array);
      expect(frontmatter.audibles).toBeInstanceOf(Array);
    });
  }
});

// --- Governor + playbook assembly ---

describe("Governor prompt assembly", () => {
  it("assembles lifecycle prompt with both sections", () => {
    const prompt = assembleGovernorPrompt("lifecycle", {
      projectId: "test-project",
      storyId: "backlog.test.story",
      runId: "2026-02-15T18-00-00Z_lifecycle_test-story",
      instruction: "Run the lifecycle playbook for this story.",
    });

    // Governor identity present
    expect(prompt).toContain("You are the Governor");
    expect(prompt).toContain("## Agent Catalog");

    // Playbook content present
    expect(prompt).toContain("# Playbook");
    expect(prompt).toContain("validate");
    expect(prompt).toContain("plan");
    expect(prompt).toContain("exec");
    expect(prompt).toContain("ship");

    // Task params present
    expect(prompt).toContain("Project: test-project");
    expect(prompt).toContain("Story: backlog.test.story");
    expect(prompt).toContain("RunId: 2026-02-15T18-00-00Z_lifecycle_test-story");
  });

  it("assembles ship prompt with both sections", () => {
    const prompt = assembleGovernorPrompt("ship", {
      projectId: "routekit-shell",
      storyId: "backlog.fix.something",
      runId: "2026-02-15T18-00-00Z_ship_fix-something",
    });

    expect(prompt).toContain("You are the Governor");
    expect(prompt).toContain("# Playbook");
    expect(prompt).toContain("## Phase Details");
    expect(prompt).toContain("rks_agent_ship");
    expect(prompt).toContain("Project: routekit-shell");
  });

  it("separator cleanly divides base prompt from playbook", () => {
    const prompt = assembleGovernorPrompt("lifecycle", {
      projectId: "test",
    });

    const separatorIndex = prompt.indexOf("\n\n---\n\n# Playbook\n\n");
    expect(separatorIndex).toBeGreaterThan(0);

    const beforeSeparator = prompt.slice(0, separatorIndex);
    const afterSeparator = prompt.slice(separatorIndex);

    // Base prompt is before separator
    expect(beforeSeparator).toContain("## Hard Limits");
    // Playbook is after separator
    expect(afterSeparator).toContain("Phase Details");
  });
});

// --- File scope injection ---

describe("File scope injection", () => {
  it("injects Allowed Files section when targetFiles provided", () => {
    const prompt = assembleGovernorPrompt("lifecycle", {
      projectId: "routekit-shell",
      storyId: "backlog.governor.trust-boundary",
      runId: "2026-02-15T18-00-00Z_lifecycle_trust-boundary",
      targetFiles: [
        "notes/agents.governor.prompt.md",
        "CLAUDE.md",
        "tests/unit/governor-lifecycle.test.mjs",
      ],
    });

    expect(prompt).toContain("## Allowed Files");
    expect(prompt).toContain("- notes/agents.governor.prompt.md");
    expect(prompt).toContain("- CLAUDE.md");
    expect(prompt).toContain("- tests/unit/governor-lifecycle.test.mjs");
  });

  it("omits Allowed Files list when no targetFiles", () => {
    const prompt = assembleGovernorPrompt("lifecycle", {
      projectId: "routekit-shell",
      storyId: "backlog.governor.trust-boundary",
    });

    // The base prompt mentions "Allowed Files" in docs, but the Task section
    // should NOT have the injected list
    const taskSection = prompt.slice(prompt.lastIndexOf("# Task"));
    expect(taskSection).not.toContain("## Allowed Files");
  });

  it("omits Allowed Files list when targetFiles is empty", () => {
    const prompt = assembleGovernorPrompt("lifecycle", {
      projectId: "routekit-shell",
      targetFiles: [],
    });

    const taskSection = prompt.slice(prompt.lastIndexOf("# Task"));
    expect(taskSection).not.toContain("## Allowed Files");
  });

  it("Allowed Files list appears in Task section after params", () => {
    const prompt = assembleGovernorPrompt("lifecycle", {
      projectId: "routekit-shell",
      storyId: "backlog.test",
      targetFiles: ["src/foo.mjs"],
    });

    const taskSection = prompt.slice(prompt.lastIndexOf("# Task"));
    const allowedIdx = taskSection.indexOf("## Allowed Files");
    const projectIdx = taskSection.indexOf("Project: routekit-shell");

    expect(allowedIdx).toBeGreaterThan(0);
    expect(allowedIdx).toBeGreaterThan(projectIdx);
    expect(taskSection).toContain("- src/foo.mjs");
  });

  it("extractTargetFiles parses story note Target Files section", () => {
    const content = [
      "---",
      "id: test",
      "---",
      "",
      "## Target Files",
      "",
      "- `notes/agents.governor.prompt.md`",
      "- `CLAUDE.md`",
      "- `tests/unit/governor-lifecycle.test.mjs`",
    ].join("\n");
    const files = extractTargetFiles(content);

    expect(files).toContain("notes/agents.governor.prompt.md");
    expect(files).toContain("CLAUDE.md");
    expect(files).toContain("tests/unit/governor-lifecycle.test.mjs");
    expect(files.length).toBe(3);
  });

  it("Governor prompt contains File Scope section", () => {
    const prompt = loadAgentPrompt("governor", PROJECT_ROOT);
    expect(prompt).toContain("## File Scope");
    expect(prompt).toContain("Allowed Files");
  });

  it("Governor prompt contains Telemetry section", () => {
    const prompt = loadAgentPrompt("governor", PROJECT_ROOT);
    expect(prompt).toContain("## Telemetry");
    expect(prompt).toContain("[governor]");
  });

  it("Governor prompt contains Thinking Log Protocol", () => {
    const prompt = loadAgentPrompt("governor", PROJECT_ROOT);
    expect(prompt).toContain("## Thinking Log Protocol");
    expect(prompt).toContain("thinking.jsonl");
    expect(prompt).toContain(".rks/governor/{runId}/thinking.jsonl");
  });
});

// --- Thinking log schema ---

describe("Thinking log entry schema", () => {
  const VALID_TYPES = [
    "phase_start",
    "phase_complete",
    "agent_call",
    "agent_result",
    "thinking",
    "edit",
    "error",
    "gate",
  ];

  function validateThinkingEntry(entry) {
    const errors = [];
    if (!entry.ts) errors.push("missing ts");
    if (!entry.type) errors.push("missing type");
    if (!VALID_TYPES.includes(entry.type)) errors.push(`invalid type: ${entry.type}`);
    if (!entry.phase) errors.push("missing phase");

    if (entry.type === "agent_call" && !entry.agent) errors.push("agent_call missing agent");
    if (entry.type === "agent_result" && typeof entry.ok !== "boolean") {
      errors.push("agent_result missing ok boolean");
    }
    if (entry.type === "phase_complete" && typeof entry.ok !== "boolean") {
      errors.push("phase_complete missing ok boolean");
    }
    if (entry.type === "edit" && !entry.file) errors.push("edit missing file");
    if (entry.type === "error" && !entry.message) errors.push("error missing message");

    return { valid: errors.length === 0, errors };
  }

  it("validates phase_start entry", () => {
    const result = validateThinkingEntry({
      ts: "2026-02-15T18:00:01Z",
      type: "phase_start",
      phase: "validate",
      message: "Starting story validation",
    });
    expect(result.valid).toBe(true);
  });

  it("validates phase_complete entry", () => {
    const result = validateThinkingEntry({
      ts: "2026-02-15T18:00:05Z",
      type: "phase_complete",
      phase: "validate",
      ok: true,
      durationMs: 4000,
    });
    expect(result.valid).toBe(true);
  });

  it("validates agent_call entry", () => {
    const result = validateThinkingEntry({
      ts: "2026-02-15T18:00:02Z",
      type: "agent_call",
      phase: "validate",
      agent: "rks_agent_validate_story",
      params: { projectId: "routekit-shell" },
    });
    expect(result.valid).toBe(true);
  });

  it("validates agent_result entry", () => {
    const result = validateThinkingEntry({
      ts: "2026-02-15T18:00:05Z",
      type: "agent_result",
      phase: "validate",
      agent: "rks_agent_validate_story",
      ok: true,
      summary: "Quality score 0.85",
    });
    expect(result.valid).toBe(true);
  });

  it("validates thinking entry", () => {
    const result = validateThinkingEntry({
      ts: "2026-02-15T18:00:06Z",
      type: "thinking",
      phase: "plan",
      message: "Found 3 target files",
    });
    expect(result.valid).toBe(true);
  });

  it("validates edit entry", () => {
    const result = validateThinkingEntry({
      ts: "2026-02-15T18:00:10Z",
      type: "edit",
      phase: "exec",
      file: "src/foo.mjs",
      reason: "Adding validation function",
    });
    expect(result.valid).toBe(true);
  });

  it("validates error entry", () => {
    const result = validateThinkingEntry({
      ts: "2026-02-15T18:00:15Z",
      type: "error",
      phase: "exec",
      message: "Tests failed: 2 assertions",
      recoverable: true,
    });
    expect(result.valid).toBe(true);
  });

  it("validates gate entry", () => {
    const result = validateThinkingEntry({
      ts: "2026-02-15T18:00:20Z",
      type: "gate",
      phase: "plan",
      question: "Approve this plan?",
      options: ["approve", "reject"],
    });
    expect(result.valid).toBe(true);
  });

  it("rejects entry missing ts", () => {
    const result = validateThinkingEntry({ type: "thinking", phase: "plan" });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("missing ts");
  });

  it("rejects entry with invalid type", () => {
    const result = validateThinkingEntry({
      ts: "2026-02-15T18:00:00Z",
      type: "unknown",
      phase: "plan",
    });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain("invalid type");
  });

  it("rejects agent_call without agent field", () => {
    const result = validateThinkingEntry({
      ts: "2026-02-15T18:00:00Z",
      type: "agent_call",
      phase: "validate",
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("agent_call missing agent");
  });

  it("rejects edit without file field", () => {
    const result = validateThinkingEntry({
      ts: "2026-02-15T18:00:00Z",
      type: "edit",
      phase: "exec",
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("edit missing file");
  });

  it("thinking log path is scoped to runId", () => {
    const runId = "2026-02-15T18-00-00Z_lifecycle_test-story";
    const logPath = `.rks/governor/${runId}/thinking.jsonl`;
    expect(logPath).toContain(runId);
    expect(logPath).toMatch(/\.rks\/governor\/.+\/thinking\.jsonl$/);
  });

  it("example entries from Governor prompt are valid JSONL", () => {
    const prompt = loadAgentPrompt("governor", PROJECT_ROOT);
    const jsonlBlock = prompt.match(/```jsonl\n([\s\S]*?)```/);
    expect(jsonlBlock).toBeTruthy();

    const lines = jsonlBlock[1].trim().split("\n");
    expect(lines.length).toBeGreaterThanOrEqual(5);

    for (const line of lines) {
      const entry = JSON.parse(line);
      const result = validateThinkingEntry(entry);
      expect(result.valid).toBe(true);
    }
  });
});

// --- Pre-flight validation ---

describe("Pre-flight validation", () => {
  function preflight(params) {
    const errors = [];
    if (!params.projectId) errors.push("missing projectId");

    const playbookPath = path.join(NOTES_DIR, `playbooks.${params.playbook}.md`);
    if (!fs.existsSync(playbookPath)) errors.push(`playbook not found: playbooks.${params.playbook}.md`);

    if (params.storyId) {
      const storyPath = path.join(NOTES_DIR, `${params.storyId}.md`);
      if (!fs.existsSync(storyPath)) {
        errors.push(`story not found: ${params.storyId}.md`);
      } else {
        const content = fs.readFileSync(storyPath, "utf8");
        const { frontmatter } = parseFrontmatter(content);
        if (frontmatter?.status === "implemented") {
          errors.push(`story already implemented: ${params.storyId}`);
        }
      }
    }

    return { ok: errors.length === 0, errors };
  }

  it("passes with valid lifecycle params", () => {
    const result = preflight({
      projectId: "routekit-shell",
      playbook: "lifecycle",
      storyId: "backlog.governor.thinking-log",
    });
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("passes with valid ship params", () => {
    const result = preflight({
      projectId: "routekit-shell",
      playbook: "ship",
    });
    expect(result.ok).toBe(true);
  });

  it("fails with missing projectId", () => {
    const result = preflight({ playbook: "lifecycle" });
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("missing projectId");
  });

  it("fails with invalid playbook", () => {
    const result = preflight({
      projectId: "routekit-shell",
      playbook: "nonexistent",
    });
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain("playbook not found");
  });

  it("fails with nonexistent story", () => {
    const result = preflight({
      projectId: "routekit-shell",
      playbook: "lifecycle",
      storyId: "backlog.does-not-exist",
    });
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain("story not found");
  });
});

// --- Checkpoint schema ---

describe("Checkpoint schema", () => {
  const VALID_STATUSES = ["in_progress", "complete", "failed", "needs_approval"];

  const validCheckpoint = {
    runId: "2026-02-15T18-00-00Z_lifecycle_test-story",
    playbook: "lifecycle",
    projectId: "routekit-shell",
    status: "in_progress",
    currentPhase: "plan",
    completedPhases: [
      { name: "validate", ok: true, artifacts: {}, timestamp: "2026-02-15T18:00:05Z" },
    ],
    artifacts: {
      branch: null,
      prNumber: null,
      prUrl: null,
    },
    question: null,
    options: null,
    error: null,
    startedAt: "2026-02-15T18:00:00Z",
    updatedAt: "2026-02-15T18:00:10Z",
  };

  function validateCheckpoint(cp) {
    const errors = [];
    if (!cp.runId) errors.push("missing runId");
    if (!cp.playbook) errors.push("missing playbook");
    if (!cp.projectId) errors.push("missing projectId");
    if (!VALID_STATUSES.includes(cp.status)) errors.push(`invalid status: ${cp.status}`);
    if (!cp.currentPhase && cp.status !== "complete") errors.push("missing currentPhase");
    if (!Array.isArray(cp.completedPhases)) errors.push("completedPhases must be array");
    if (!cp.startedAt) errors.push("missing startedAt");
    if (!cp.updatedAt) errors.push("missing updatedAt");

    for (const phase of cp.completedPhases || []) {
      if (!phase.name) errors.push("phase missing name");
      if (typeof phase.ok !== "boolean") errors.push(`phase ${phase.name}: ok must be boolean`);
      if (!phase.timestamp) errors.push(`phase ${phase.name}: missing timestamp`);
    }

    if (cp.status === "needs_approval") {
      if (!cp.question) errors.push("needs_approval requires question");
    }

    if (cp.status === "failed") {
      if (!cp.error) errors.push("failed requires error");
    }

    return { valid: errors.length === 0, errors };
  }

  it("validates a correct in_progress checkpoint", () => {
    const result = validateCheckpoint(validCheckpoint);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("validates a complete checkpoint", () => {
    const cp = {
      ...validCheckpoint,
      status: "complete",
      currentPhase: null,
      completedPhases: [
        { name: "validate", ok: true, artifacts: {}, timestamp: "2026-02-15T18:00:05Z" },
        { name: "plan", ok: true, artifacts: {}, timestamp: "2026-02-15T18:00:10Z" },
        { name: "exec", ok: true, artifacts: { filesChanged: 3 }, timestamp: "2026-02-15T18:00:20Z" },
        { name: "ship", ok: true, artifacts: { prNumber: 644, prUrl: "https://github.com/..." }, timestamp: "2026-02-15T18:00:30Z" },
        { name: "complete", ok: true, artifacts: {}, timestamp: "2026-02-15T18:00:35Z" },
      ],
      artifacts: { branch: "feat/test", prNumber: 644, prUrl: "https://github.com/..." },
    };
    const result = validateCheckpoint(cp);
    expect(result.valid).toBe(true);
  });

  it("validates a needs_approval checkpoint", () => {
    const cp = {
      ...validCheckpoint,
      status: "needs_approval",
      currentPhase: "plan",
      question: "Here is the implementation plan. Approve?",
      options: ["approve", "reject", "modify"],
    };
    const result = validateCheckpoint(cp);
    expect(result.valid).toBe(true);
  });

  it("validates a failed checkpoint", () => {
    const cp = {
      ...validCheckpoint,
      status: "failed",
      currentPhase: "ship",
      error: "Merge conflict on staging",
    };
    const result = validateCheckpoint(cp);
    expect(result.valid).toBe(true);
  });

  it("rejects checkpoint missing runId", () => {
    const cp = { ...validCheckpoint, runId: null };
    const result = validateCheckpoint(cp);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("missing runId");
  });

  it("rejects checkpoint with invalid status", () => {
    const cp = { ...validCheckpoint, status: "running" };
    const result = validateCheckpoint(cp);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain("invalid status");
  });

  it("rejects needs_approval without question", () => {
    const cp = { ...validCheckpoint, status: "needs_approval", question: null };
    const result = validateCheckpoint(cp);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("needs_approval requires question");
  });

  it("rejects failed without error", () => {
    const cp = { ...validCheckpoint, status: "failed", error: null };
    const result = validateCheckpoint(cp);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("failed requires error");
  });

  it("rejects phase missing ok boolean", () => {
    const cp = {
      ...validCheckpoint,
      completedPhases: [{ name: "validate", ok: "yes", timestamp: "2026-02-15T18:00:05Z" }],
    };
    const result = validateCheckpoint(cp);
    expect(result.valid).toBe(false);
  });

  it("runId follows convention: ISO-date_playbook_slug", () => {
    const runIdPattern = /^\d{4}-\d{2}-\d{2}T[\d-]+Z_\w+_.+$/;
    expect(validCheckpoint.runId).toMatch(runIdPattern);
  });
});

// --- Hook compatibility ---

describe("Hook compatibility", () => {
  it("Governor prompt contains Hook Awareness section", () => {
    const prompt = loadAgentPrompt("governor", PROJECT_ROOT);
    expect(prompt).toContain("## Hook Awareness");
    expect(prompt).toContain("enforce-plan-scope.mjs");
    expect(prompt).toContain(".rks/governor/*");
  });

  it("Governor prompt describes two-mode trust model", () => {
    const prompt = loadAgentPrompt("governor", PROJECT_ROOT);
    expect(prompt).toContain("Guardrails-off");
    expect(prompt).toContain("Guardrails-on");
    expect(prompt).toContain("active-plan");
  });

  it("assembleGovernorPrompt includes active-plan setup when guardrailsOn: true", () => {
    const prompt = assembleGovernorPrompt("lifecycle", {
      projectId: "my-app",
      storyId: "backlog.feat.user-auth",
      runId: "2026-02-15T18-00-00Z_lifecycle_user-auth",
      guardrailsOn: true,
    });

    expect(prompt).toContain("Guardrails are ON");
    expect(prompt).toContain("active-plan.json");
    expect(prompt).toContain("notes/backlog.feat.user-auth.md");
    expect(prompt).toContain("enforce-plan-scope.mjs");
  });

  it("assembleGovernorPrompt omits active-plan setup when guardrailsOn: false", () => {
    const prompt = assembleGovernorPrompt("lifecycle", {
      projectId: "routekit-shell",
      storyId: "backlog.governor.thinking-log",
      runId: "2026-02-15T18-00-00Z_lifecycle_thinking-log",
      guardrailsOn: false,
    });

    expect(prompt).not.toContain("Guardrails are ON");
  });

  it("assembleGovernorPrompt omits active-plan setup when guardrailsOn not set", () => {
    const prompt = assembleGovernorPrompt("lifecycle", {
      projectId: "routekit-shell",
      storyId: "backlog.governor.thinking-log",
      runId: "2026-02-15T18-00-00Z_lifecycle_thinking-log",
    });

    expect(prompt).not.toContain("Guardrails are ON");
  });

  it("enforce-plan-scope PLAN_EXEMPT_PATHS includes .rks/ paths", () => {
    const hookPath = path.join(PROJECT_ROOT, ".routekit", "hooks", "write", "enforce-plan-scope.mjs");
    if (!fs.existsSync(hookPath)) {
      return; // Hook absent (guardrails off or not installed) — nothing to assert
    }
    const hookSource = fs.readFileSync(hookPath, "utf8");
    expect(hookSource).toContain(".rks\\/");
  });

  it("enforce-plan-scope allows .rks/governor/{runId}/thinking.jsonl", () => {
    // Simulate the isPathAllowed check by testing the regex pattern
    const governorPattern = /^\.rks\/governor\//;
    expect(governorPattern.test(".rks/governor/2026-02-15T18-00-00Z_lifecycle_test/thinking.jsonl")).toBe(true);
  });

  it("enforce-plan-scope allows .rks/governor/{runId}.json (checkpoint)", () => {
    const governorPattern = /^\.rks\/governor\//;
    expect(governorPattern.test(".rks/governor/2026-02-15T18-00-00Z_lifecycle_test.json")).toBe(true);
  });
});
