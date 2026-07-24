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
import { runRagQuery } from '../rag/index.mjs';
import { ensureTelemetryStorage } from './telemetry/index.mjs';

/**
 * Load review policy from .rks/review-policy.yaml
 */
export function loadReviewPolicy(projectRoot) {
  const policyPath = path.join(projectRoot, '.rks', 'review-policy.yaml');
  const defaults = {
    enabled: true,
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

  // Check for security patterns in diff (only in added lines)
  const addedLines = diff.split('\n').filter(line => line.startsWith('+') && !line.startsWith('+++'));

  for (const pattern of policy.securityPatterns || []) {
    const regex = new RegExp(pattern, 'i');
    for (const line of addedLines) {
      if (regex.test(line)) {
        findings.push({
          category: 'security_issue',
          severity: 'block',
          message: `Potential security issue: pattern "${pattern}" found`,
          line: line.slice(1).trim().slice(0, 100),
          suggestion: 'Review this code for security implications',
        });
      }
    }
  }

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
      error: `Reviewer LLM call failed: ${err.message}`,
    };
  }
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
      // LLM failed - fall back to pattern-only review
      const hasBlockers = patternFindings.some(f => f.severity === 'block');
      const verdict = hasBlockers ? 'block' : (patternFindings.length > 0 ? 'warn' : 'pass');

      collector.emit('review.complete', projectId, {
        problemId,
        verdict,
        findingCount: patternFindings.length,
        blockerCount: patternFindings.filter(f => f.severity === 'block').length,
        warningCount: patternFindings.filter(f => f.severity === 'warn').length,
        llmFailed: true,
      });

      return {
        ok: true,
        verdict,
        summary: llmResult.error || 'Pattern-based review only (LLM unavailable)',
        findings: patternFindings,
        llmFailed: true,
      };
    }

    // Combine pattern findings with LLM findings
    const allFindings = [...patternFindings, ...(llmResult.findings || [])];

    // Determine final verdict based on policy
    let finalVerdict = llmResult.verdict || 'pass';

    // Upgrade to block if pattern checks found blockers
    const hasPatternBlockers = patternFindings.some(f =>
      policy.blockCategories?.includes(f.category)
    );
    if (hasPatternBlockers && finalVerdict !== 'block') {
      finalVerdict = 'block';
    }

    // Apply verdictMode from policy
    if (policy.verdictMode === 'warn' && finalVerdict === 'block') {
      // Check if it's a hard block (enforcement/security) or soft block
      const hasHardBlock = allFindings.some(f =>
        f.severity === 'block' &&
        (f.category === 'enforcement_modification' || f.category === 'security_issue')
      );
      if (!hasHardBlock) {
        finalVerdict = 'warn';
      }
    } else if (policy.verdictMode === 'skip') {
      finalVerdict = 'pass';
    }

    collector.emit('review.complete', projectId, {
      problemId,
      verdict: finalVerdict,
      findingCount: allFindings.length,
      blockerCount: allFindings.filter(f => f.severity === 'block').length,
      warningCount: allFindings.filter(f => f.severity === 'warn').length,
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
