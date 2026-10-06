import fs from "fs/promises";
import path from "path";
import { glob } from "glob";

const FAILURE_CATEGORIES = {
  missing_target_files: {
    patterns: ["note_only", "no targetFiles", "not listed as editable"],
    suggestions: [
      "Add targetFiles field to story frontmatter",
      "Use rks_refine_apply to add target files automatically"
    ]
  },
  stale_search_pattern: {
    patterns: ["pattern not found", "search_pattern_not_found", "Search pattern"],
    suggestions: [
      "Read current file content with rks_code_context",
      "Update SEARCH blocks in story with exact current code",
      "Use verbatim code snippets from the file"
    ]
  },
  rag_miss: {
    patterns: ["quality_failed", "low RAG", "needs_code_context"],
    suggestions: [
      "Add more detail to story description",
      "Run rks_rag_embed to refresh index",
      "Add code snippets showing expected patterns"
    ]
  },
  test_failure: {
    patterns: ["tests fail", "test_failed", "npm test"],
    suggestions: [
      "Review test output for specific failures",
      "Check if test expectations match implementation",
      "Run tests locally to debug"
    ]
  },
  llm_hallucination: {
    patterns: ["invalid file", "bad syntax", "destructive_edit"],
    suggestions: [
      "Add explicit code snippets to story",
      "Specify exact file paths in targetFiles",
      "Break into smaller, focused stories"
    ]
  }
};

export async function analyzeFailure(projectRoot, opts = {}) {
  const { correlationId, eventId, runId } = opts;
  
  // Find relevant failure events
  let failureEvent = null;
  let relatedEvents = [];
  
  // Check run folder for failure context
  if (runId) {
    const runDir = path.join(projectRoot, ".rks", "runs", runId);
    try {
      const planPath = path.join(runDir, "plan.json");
      const planContent = await fs.readFile(planPath, "utf8");
      const plan = JSON.parse(planContent);
      
      if (plan.status !== "executable" || plan.qualityReview?.errors?.length) {
        failureEvent = {
          type: "plan.failed",
          status: plan.status,
          errors: plan.qualityReview?.errors || [],
          warnings: plan.qualityReview?.warnings || []
        };
      }
    } catch (err) {
      // No plan file found
    }
  }
  
  if (!failureEvent) {
    return {
      ok: true,
      analysis: null,
      message: "No failure found for given parameters"
    };
  }
  
  // Categorize the failure
  const errorText = JSON.stringify(failureEvent).toLowerCase();
  let category = "unknown";
  let confidence = "low";
  let suggestions = ["Review the error message and plan output"];
  
  for (const [cat, config] of Object.entries(FAILURE_CATEGORIES)) {
    for (const pattern of config.patterns) {
      if (errorText.includes(pattern.toLowerCase())) {
        category = cat;
        confidence = "high";
        suggestions = config.suggestions;
        break;
      }
    }
    if (category !== "unknown") break;
  }
  
  // Find related successful stories
  const relatedSuccesses = await findRelatedSuccesses(projectRoot, failureEvent);
  
  return {
    ok: true,
    failure: failureEvent,
    analysis: {
      category,
      confidence,
      suggestions,
      relatedSuccesses
    }
  };
}

async function findRelatedSuccesses(projectRoot, failureEvent) {
  const notesDir = path.join(projectRoot, "notes");
  try {
    const implemented = await glob("backlog.z_implemented.*.md", { cwd: notesDir });
    // Return up to 3 most recent implemented stories
    return implemented.slice(-3).map(f => f.replace(".md", ""));
  } catch {
    return [];
  }
}
