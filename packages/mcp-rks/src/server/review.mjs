/**
 * Agent Code Review Module
 *
 * Spawns a distinct reviewer agent with isolated context to evaluate PRs.
 * The key insight: context separation provides unbiased review.
 * A fresh agent sees only the diff, story, and patterns - not the debugging journey.
 */

import { spawnSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import { loadEnv, createAnthropicClient, callAnthropicChat, DEFAULT_LLM_TIMEOUT_MS } from '../llm/clients.mjs';
import { loadContext } from './project.mjs';
import { resolveNotesDir, readNote } from '../dendron.mjs';
import { runRagQuery } from '@routekit/rag';
import { ensureTelemetryStorage } from '@routekit/telemetry';

/**
 * Load review policy from .rks/review-policy.yaml
 */
export function loadReviewPolicy(projectRoot) {
  const policyPath = path.join(projectRoot, '.rks', 'review-policy.yaml');
  const defaults = {
    enabled: true,
    // Fail CLOSED by default: a reviewer that could not run must stop the ship.
    // Opting out has to be an explicit, recorded decision in the policy file —
    // never something you arrive at by forgetting to set a credential.
    failOpen: false,
    model: 'claude-sonnet-4-6',
    verdictMode: 'warn',
    blockCategories: ['enforcement_modification', 'security_issue'],
    warnCategories: ['missing_error_handling', 'test_coverage', 'anti_patterns', 'ac_coverage'],
    enforcementPaths: ['.routekit/hooks/', '.rks/protected-files.yml', '.rks/review-policy.yaml'],
    securityPatterns: ['eval\\(', 'new Function\\(', 'password.*=.*[\'"]', 'api[_-]?key.*=.*[\'"]', 'secret.*=.*[\'"]'],
    antiPatterns: ['console\\.log\\(', '// TODO', '// FIXME', 'debugger;'],
  };

  try {
    if (fs.existsSync(policyPath)) {
      const content = fs.readFileSync(policyPath, 'utf8');
      const loaded = yaml.load(content) || {};
      return { ...defaults, ...loaded };
    }
  } catch (err) {
    console.error(`[review] Failed to load policy: ${err.message}`);
  }

  return defaults;
}

/**
 * Get the diff for review
 */
export function getDiff(projectRoot, targetBranch = 'staging') {
  const result = spawnSync('git', ['diff', `${targetBranch}...HEAD`, '--unified=5'], {
    cwd: projectRoot,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024, // 10MB for large diffs
  });

  if (result.error) {
    throw new Error(`Failed to get diff: ${result.error.message}`);
  }

  return result.stdout || '';
}

/**
 * Get list of changed files
 */
export function getChangedFiles(projectRoot, targetBranch = 'staging') {
  const result = spawnSync('git', ['diff', `${targetBranch}...HEAD`, '--name-only'], {
    cwd: projectRoot,
    encoding: 'utf8',
  });

  if (result.error) {
    return [];
  }

  return (result.stdout || '').split('\n').filter(Boolean);
}

/**
 * Run pattern-based checks (fast, no LLM required)
 */
/**
 * Compute the final verdict from pattern findings, all findings, the LLM's
 * verdict, and policy. PURE — no git, no disk, no credential.
 *
 * Extracted from runReview because it was UNREACHABLE from a test: runReview
 * shells out to git via getDiff/getChangedFiles, loads policy from disk, and
 * calls a module-private reviewer needing a live credential, so nothing could
 * drive this logic. That is why its only coverage was a source-text scan — the
 * brittleness of those pins was a symptom of the untestability, not a separate
 * defect. This seam is what lets the verdict rules be asserted directly.
 *
 * Must stay in THIS file: tests/unit/ship-review-fail-closed.test.mjs asserts
 * against the whole source text of review.mjs, so relocating this would empty
 * those pins rather than merely moving them.
 */
export function computeFinalVerdict({ patternFindings = [], allFindings = [], llmVerdict, policy = {} }) {
  let finalVerdict = llmVerdict || 'pass';

  // Upgrade to block only when a pattern finding is BOTH block-severity AND in
  // a blocking category. Keying on category alone meant a warn-severity finding
  // still forced a block, which then had to be softened back by verdictMode —
  // putting a policy value on the critical path of a correctness decision.
  const hasPatternBlockers = patternFindings.some(f =>
    f.severity === 'block' && policy.blockCategories?.includes(f.category)
  );
  if (hasPatternBlockers && finalVerdict !== 'block') {
    finalVerdict = 'block';
  }

  // Apply verdictMode from policy
  if (policy.verdictMode === 'warn' && finalVerdict === 'block') {
    // Hard blocks are whatever policy declares un-softenable. Previously the two
    // category names were hardcoded here, which made blockCategories decorative
    // on this branch — editing policy changed nothing.
    const hardBlockCategories = policy.blockCategories || [];
    const hasHardBlock = allFindings.some(f =>
      f.severity === 'block' && hardBlockCategories.includes(f.category)
    );
    if (!hasHardBlock) {
      finalVerdict = 'warn';
    }
  } else if (policy.verdictMode === 'skip') {
    finalVerdict = 'pass';
  }

  return finalVerdict;
}

export function runPatternChecks(diff, changedFiles, policy) {
  const findings = [];

  // Check for enforcement file modifications
  for (const file of changedFiles) {
    for (const enforcementPath of policy.enforcementPaths || []) {
      if (file.startsWith(enforcementPath) || file === enforcementPath) {
        findings.push({
          category: 'enforcement_modification',
          severity: 'block',
          file,
          message: `Modification to enforcement file: ${file}`,
          suggestion: 'Ensure this change is intentional and reviewed by a human',
        });
      }
    }
  }

  // Attribute each added line to the file it belongs to, by tracking the most
  // recent `+++ b/<path>` header. Needed so a credential-shaped literal in a
  // TEST FIXTURE can be downgraded — without it, the very test that proves this
  // gate still blocks real secrets would hard-block its own ship.
  //
  // An added line with NO preceding header is UNATTRIBUTED and is treated as
  // non-test, keeping full severity. That fails safe: silently downgrading
  // unattributed lines would open a hole in the gate this change exists to
  // sharpen. It is a live case, not hypothetical — callers pass a bare '' diff.
  const attributedAddedLines = [];
  let currentFile = null;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++')) {
      const match = line.match(/^\+\+\+ b\/(.+)$/);
      currentFile = match ? match[1].trim() : null;
      continue;
    }
    if (line.startsWith('---')) continue;
    if (line.startsWith('+')) attributedAddedLines.push({ line, file: currentFile });
  }
  const addedLines = attributedAddedLines.map(entry => entry.line);

  // Note the `tests/` prefix arm: diff paths are repo-relative, so a bare
  // `/tests/` substring check misses the top-level tests/ directory entirely —
  // tests/helpers/foo.mjs would not be recognised as a test file.
  const isTestPath = (f) => !!f && (
    f.includes('.test.') || f.includes('.spec.') || f.includes('__tests__') ||
    f.includes('/tests/') || f.startsWith('tests/')
  );

  // Two tiers, ONE category. securityPatterns are the enumerated hard-block set;
  // securityHeuristics carry the same security_issue category so telemetry and
  // reviewers still see them, at warn severity so they cannot hard-block.
  const scanSecurity = (patterns, baseSeverity) => {
    for (const pattern of patterns || []) {
      const regex = new RegExp(pattern, 'i');
      for (const { line, file } of attributedAddedLines) {
        if (!regex.test(line)) continue;
        // Downgraded in test files, never dropped, and the category is kept.
        const severity = baseSeverity === 'block' && isTestPath(file) ? 'warn' : baseSeverity;
        findings.push({
          category: 'security_issue',
          severity,
          ...(file ? { file } : {}),
          message: `Potential security issue: pattern "${pattern}" found`,
          line: line.slice(1).trim().slice(0, 100),
          suggestion: 'Review this code for security implications',
        });
      }
    }
  };

  scanSecurity(policy.securityPatterns, 'block');
  scanSecurity(policy.securityHeuristics, 'warn');

  // Check for anti-patterns in diff
  for (const pattern of policy.antiPatterns || []) {
    const regex = new RegExp(pattern, 'i');
    for (const line of addedLines) {
      if (regex.test(line)) {
        findings.push({
          category: 'anti_patterns',
          severity: 'warn',
          message: `Anti-pattern detected: "${pattern}"`,
          line: line.slice(1).trim().slice(0, 100),
          suggestion: 'Consider removing before shipping',
        });
      }
    }
  }

  // Check for test coverage (code changes without test changes)
  const codeFiles = changedFiles.filter(f =>
    (f.endsWith('.js') || f.endsWith('.mjs') || f.endsWith('.ts') || f.endsWith('.tsx')) &&
    !f.includes('.test.') && !f.includes('.spec.') && !f.includes('__tests__') && !f.includes('/tests/')
  );
  const testFiles = changedFiles.filter(f =>
    f.includes('.test.') || f.includes('.spec.') || f.includes('__tests__') || f.includes('/tests/')
  );

  if (codeFiles.length > 0 && testFiles.length === 0) {
    findings.push({
      category: 'test_coverage',
      severity: 'warn',
      message: `${codeFiles.length} code file(s) modified without test changes`,
      files: codeFiles.slice(0, 5),
      suggestion: 'Consider adding tests for new functionality',
    });
  }

  return findings;
}

/**
 * Build the review prompt for the LLM reviewer
 */
export function buildReviewPrompt({ diff, story, ragContext, changedFiles }) {
  const storySection = story ? `
## Story Being Implemented
Title: ${story.title || 'Unknown'}
Description: ${story.desc || 'No description'}

### Acceptance Criteria
${story.content?.match(/## Acceptance Criteria[\s\S]*?(?=##|$)/)?.[0] || 'Not specified'}

### Testing Requirements
${story.content?.match(/## Testing Requirements[\s\S]*?(?=##|$)/)?.[0] || 'Not specified'}
` : '## Story: Not provided';

  const ragSection = ragContext?.length > 0 ? `
## Relevant Patterns from Codebase
${ragContext.map(r => `- ${r.path}: ${r.text?.slice(0, 200)}...`).join('\n')}
` : '';

  return `You are a code reviewer with a fresh perspective. You have NOT seen the conversation that led to these changes - you see ONLY the diff and requirements.

Your job is to find issues, not rubber-stamp changes. Be skeptical but fair.

## Changed Files
${changedFiles.join('\n')}

${storySection}
${ragSection}

## Diff to Review
\`\`\`diff
${diff.slice(0, 50000)}
\`\`\`

## Your Task

Review this diff and identify issues. Respond with JSON only:

{
  "verdict": "pass" | "warn" | "block",
  "summary": "One sentence summary of your review",
  "findings": [
    {
      "category": "ac_coverage" | "missing_error_handling" | "test_coverage" | "other",
      "severity": "block" | "warn" | "info",
      "file": "affected file or null",
      "line": "relevant code snippet or null",
      "message": "what's the issue",
      "suggestion": "how to fix it"
    }
  ],
  "acCoverage": {
    "assessed": true,
    "covered": ["list of AC that appear covered"],
    "notCovered": ["list of AC that may not be covered"],
    "uncertain": ["list of AC where coverage is unclear"]
  }
}

## Review Checklist

1. **AC Coverage**: Does the diff implement the acceptance criteria? Check each criterion.
2. **Error Handling**: Are error paths considered? Try/catch where needed? Meaningful error messages?
3. **Test Quality**: If tests exist, do they test the actual behavior change?
4. **Code Quality**: Obvious bugs? Logic errors? Missing null checks?

## Verdict Rules

- **pass**: No issues or only informational notes
- **warn**: Issues found but not blocking (missing tests, minor concerns)
- **block**: Critical issues (security, obvious bugs, completely missing AC)

Be specific. Reference actual code from the diff in your findings.
`;
}

/**
 * Call the reviewer LLM
 */
async function callReviewer({ prompt, policy }) {
  const env = loadEnv();

  if (!env.anthropicKey) {
    return {
      ok: false,
      cause: 'not_configured',
      error: 'No ANTHROPIC_API_KEY configured for reviewer',
    };
  }

  const client = createAnthropicClient({ ...env, provider: 'anthropic' });
  const model = policy.model || 'claude-sonnet-4-6';

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_LLM_TIMEOUT_MS);

  try {
    const response = await callAnthropicChat({
      client,
      model,
      prompt,
      signal: controller.signal,
    });

    clearTimeout(timeout);

    // Parse JSON response
    let parsed;
    try {
      // Handle potential markdown code fences
      const cleaned = response.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      parsed = JSON.parse(cleaned);
    } catch (parseErr) {
      return {
        ok: false,
        cause: 'call_failed',
        error: `Failed to parse reviewer response: ${parseErr.message}`,
        rawResponse: response.slice(0, 500),
      };
    }

    return {
      ok: true,
      ...parsed,
    };
  } catch (err) {
    clearTimeout(timeout);
    return {
      ok: false,
      cause: 'call_failed',
      error: `Reviewer LLM call failed: ${err.message}`,
    };
  }
}

/**
 * Build the review result for a reviewer that did NOT run.
 *
 * Pattern-only output is a degraded MODE, not a pass. Absence of pattern hits is
 * evidence that a handful of regexes did not match — not evidence that the change
 * is correct. Before this existed, a 404 on a retired model id surfaced as
 * `verdict: 'pass', findingCount: 0`, and every story shipped through that path
 * had a review gate reporting a pass it never performed.
 *
 * `ok` is pinned to `true` DELIBERATELY. `ok` means "the review module produced a
 * result", not "the change is acceptable" — unavailability is carried by `verdict`,
 * `reviewerUnavailable` and `cause`. Returning `ok: false` here would be the natural
 * reading and is wrong twice over: story-ship.mjs branches on `reviewResult.ok`, so
 * `false` routes to the else path that records a skipped step and merges anyway —
 * reinstating this very fail-open under a new name — and it would also bypass the
 * pattern-derived `block` halt.
 *
 * `cause` is a two-value machine-readable discriminator stamped at the callReviewer
 * exit sites, never parsed back out of the free-text error string.
 *
 * @param {object} args
 * @param {string} [args.error]                     underlying reviewer error
 * @param {'not_configured'|'call_failed'} [args.cause]
 * @param {Array<{severity?: string}>} [args.patternFindings]
 */
export function buildUnavailableReview({ error, cause, patternFindings = [] } = {}) {
  const findings = Array.isArray(patternFindings) ? patternFindings : [];
  const hasBlockers = findings.some((f) => f?.severity === 'block');

  return {
    ok: true,
    // Never 'pass'. A blocking pattern finding still blocks; everything else
    // reports the truth, which is that the reviewer was unavailable.
    verdict: hasBlockers ? 'block' : 'unavailable',
    reviewerUnavailable: true,
    llmFailed: true,
    cause: cause === 'not_configured' ? 'not_configured' : 'call_failed',
    error: error || 'Reviewer LLM unavailable',
    summary: error || 'Pattern-based review only (reviewer LLM unavailable)',
    findings,
  };
}

/**
 * How many findings survive into a persisted record.
 *
 * 25 renders incident 54602ef4 (21 findings, 15 blockers) in full, so the cap
 * never bites on the case that motivated persisting findings at all, while
 * still bounding any single record to a few KB.
 */
export const MAX_PERSISTED_FINDINGS = 25;

/**
 * Strip source text out of findings so they can be persisted.
 *
 * `line` is NOT a line number — runPatternChecks sets it to
 * `line.slice(1).trim().slice(0, 100)`, i.e. up to 100 characters of the matched
 * ADDED diff line. The configured securityPatterns include `password.*=.*['"]`,
 * `api[_-]?key.*=.*['"]` and `secret.*=.*['"]`, so for a security finding the
 * matched line IS the assignment including its literal value. Persisting a
 * finding verbatim writes a real credential into telemetry.
 *
 * Kept: category, severity, file, message, suggestion, files. The security
 * `message` embeds the PATTERN, not the matched value, so it is safe.
 *
 * Dropped: `line`, unconditionally — on EVERY finding, not just pattern ones.
 * An LLM finding's `line` is model-authored and untrusted, and `line:` occurs in
 * only two places in this file, so anything else claiming to be a line number
 * came from the model. Drop, do not validate: a helper that keeps values passing
 * a plausibility check is a helper that leaks the day a check is wrong.
 *
 * Blockers are kept first so a truncated record still shows what blocked.
 * Never mutates its input.
 */
export function redactFindings(findings, limit = MAX_PERSISTED_FINDINGS) {
  if (!Array.isArray(findings)) return [];
  const rank = (f) => (f?.severity === 'block' ? 0 : f?.severity === 'warn' ? 1 : 2);
  const ordered = findings
    .map((f, i) => ({ f, i }))
    .sort((a, b) => rank(a.f) - rank(b.f) || a.i - b.i)
    .map(({ f }) => f);

  return ordered.slice(0, limit).map((f) => {
    const safe = {
      category: f?.category,
      severity: f?.severity,
      message: f?.message,
    };
    if (f?.file !== undefined) safe.file = f.file;
    if (f?.suggestion !== undefined) safe.suggestion = f.suggestion;
    if (f?.files !== undefined) safe.files = f.files;
    return safe;
  });
}

/**
 * Shallow-copy a review result with its findings redacted.
 *
 * The whole review object is passed into ship failure payloads, so redacting
 * only the step entry would leave a raw `review.findings[].line` sitting beside
 * it in the same response. Never mutates its input.
 */
export function redactReview(reviewResult) {
  if (!reviewResult || typeof reviewResult !== 'object') return reviewResult;
  return { ...reviewResult, findings: redactFindings(reviewResult.findings) };
}

/**
 * Main review entry point
 */
export async function runReview({ projectId, problemId, branch, targetBranch = 'staging' }) {
  const context = await loadContext(projectId);
  const projectRoot = context.record.root;
  const policy = loadReviewPolicy(projectRoot);
  const collector = ensureTelemetryStorage(projectRoot);

  // Check if review is enabled
  if (!policy.enabled) {
    return {
      ok: true,
      verdict: 'pass',
      skipped: true,
      reason: 'Review disabled in policy',
    };
  }

  collector.emit('review.started', projectId, { problemId, branch });

  try {
    // Get diff and changed files
    const diff = getDiff(projectRoot, targetBranch);
    const changedFiles = getChangedFiles(projectRoot, targetBranch);

    if (!diff || changedFiles.length === 0) {
      return {
        ok: true,
        verdict: 'pass',
        summary: 'No changes to review',
        findings: [],
      };
    }

    // Run pattern-based checks first (fast)
    const patternFindings = runPatternChecks(diff, changedFiles, policy);

    // Load story if provided
    let story = null;
    if (problemId) {
      try {
        const notesDir = resolveNotesDir(projectRoot);
        story = readNote(notesDir, problemId);
      } catch {
        // Story not found - continue without it
      }
    }

    // Query RAG for relevant patterns (if available)
    let ragContext = [];
    try {
      const ragResult = await runRagQuery({
        projectId,
        q: `code patterns ${changedFiles.slice(0, 3).join(' ')}`,
        k: 3,
      });
      if (ragResult.ok && ragResult.matches) {
        ragContext = ragResult.matches;
      }
    } catch {
      // RAG not available - continue without it
    }

    // Build prompt and call reviewer
    const prompt = buildReviewPrompt({ diff, story, ragContext, changedFiles });

    // Emit telemetry for auditability - track what went into the prompt
    collector.emit('review.prompt.assembled', projectId, {
      problemId,
      diffLines: diff.split('\n').length,
      diffBytes: diff.length,
      changedFileCount: changedFiles.length,
      changedFiles,
      storyIncluded: !!story,
      storyTitle: story?.title || null,
      ragContextCount: ragContext.length,
      promptLength: prompt.length,
      promptHash: crypto.createHash('sha256').update(prompt).digest('hex').slice(0, 16),
    });

    const llmResult = await callReviewer({ prompt, policy });

    if (!llmResult.ok) {
      // The reviewer did NOT run. Degrade to pattern-only, but never call it a pass.
      const unavailable = buildUnavailableReview({
        error: llmResult.error,
        cause: llmResult.cause,
        patternFindings,
      });

      collector.emit('review.complete', projectId, {
        problemId,
        verdict: unavailable.verdict,
        findingCount: patternFindings.length,
        blockerCount: patternFindings.filter(f => f.severity === 'block').length,
        warningCount: patternFindings.filter(f => f.severity === 'warn').length,
        llmFailed: true,
        reviewerUnavailable: true,
        cause: unavailable.cause,
        findings: redactFindings(patternFindings),
      });

      return unavailable;
    }

    // Combine pattern findings with LLM findings
    const allFindings = [...patternFindings, ...(llmResult.findings || [])];

    // Determine final verdict based on policy
    const finalVerdict = computeFinalVerdict({
      patternFindings,
      allFindings,
      llmVerdict: llmResult.verdict,
      policy,
    });

    collector.emit('review.complete', projectId, {
      problemId,
      verdict: finalVerdict,
      findingCount: allFindings.length,
      blockerCount: allFindings.filter(f => f.severity === 'block').length,
      warningCount: allFindings.filter(f => f.severity === 'warn').length,
      findings: redactFindings(allFindings),
    });

    return {
      ok: true,
      verdict: finalVerdict,
      summary: llmResult.summary || `Review complete: ${allFindings.length} finding(s)`,
      findings: allFindings,
      acCoverage: llmResult.acCoverage || null,
      changedFiles,
      policy: {
        verdictMode: policy.verdictMode,
        model: policy.model,
      },
    };
  } catch (err) {
    collector.emit('review.failed', projectId, { problemId, error: err.message });
    return {
      ok: false,
      error: `Review failed: ${err.message}`,
    };
  }
}

export default {
  loadReviewPolicy,
  getDiff,
  getChangedFiles,
  runPatternChecks,
  buildReviewPrompt,
  runReview,
};
