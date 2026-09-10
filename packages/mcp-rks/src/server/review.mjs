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
 * The ONE definition of "secret-shaped" in this module.
 *
 * Lifted out of the loadReviewPolicy defaults so `redactReview` can scrub free
 * text on a path that carries no policy object. Reusing this list rather than
 * writing a second set of regexes is what keeps `scrubSecretLiterals`' promise
 * that "secret-shaped" has one definition here.
 */
export const DEFAULT_SECURITY_PATTERNS = [
  'password.*=.*[\'"]',
  'api[_-]?key.*=.*[\'"]',
  'secret.*=.*[\'"]',
];

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
    // Suppress the story's phase advance when the reviewer produced no usable
    // acceptance-criteria evidence. Same posture as failOpen above, for the same
    // reason: "the reviewer did not assess" and "the reviewer found nothing wrong"
    // are different facts, and only one of them means the story is done. Advancing
    // on absent evidence has to be an explicit, recorded decision in the policy
    // file — never something you arrive at by a reviewer failing to run.
    advancePhaseOnUnassessedAC: false,
    blockCategories: ['enforcement_modification', 'security_issue'],
    warnCategories: ['missing_error_handling', 'test_coverage', 'anti_patterns', 'ac_coverage'],
    enforcementPaths: ['.routekit/hooks/', '.rks/protected-files.yml', '.rks/review-policy.yaml'],
    securityPatterns: ['eval\\(', 'new Function\\(', ...DEFAULT_SECURITY_PATTERNS],
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
 *
 * RETURNS A STRUCTURED RESULT, not a bare string. The `verdict` value and every
 * decision that produces it are unchanged — what is added is the RECORD of why.
 * A policy-softened `block` and a genuine `warn` used to be the same byte in the
 * payload, so a ship report could say "warn, minor findings" over findings whose
 * own `severity` read `block`, and nothing in the object said which half won.
 * `downgradedFrom` is null whenever no downgrade occurred, so the two cases are
 * told apart by field presence rather than by re-deriving policy at the reader.
 *
 * An UPGRADE is not a downgrade: the hasPatternBlockers promotion below leaves
 * both fields null.
 *
 * @returns {{ verdict: 'pass'|'warn'|'block', downgradedFrom: string|null, downgradeReason: string|null }}
 */
export function computeFinalVerdict({ patternFindings = [], allFindings = [], llmVerdict, policy = {} }) {
  let finalVerdict = llmVerdict || 'pass';
  let downgradedFrom = null;
  let downgradeReason = null;

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
      // Name the categories that were softened AND the policy field that
      // permitted it, so the reader can act on the reason without re-reading
      // the policy file or the findings array.
      const softenedCategories = [...new Set(
        allFindings
          .filter((f) => f?.severity === 'block')
          .map((f) => f?.category)
          .filter(Boolean)
      )];
      downgradedFrom = 'block';
      downgradeReason =
        `verdictMode 'warn' downgraded block to warn: ` +
        (softenedCategories.length
          ? `block-severity finding categories [${softenedCategories.join(', ')}] are not listed in policy blockCategories [${hardBlockCategories.join(', ')}]`
          : `no block-severity finding matched policy blockCategories [${hardBlockCategories.join(', ')}]`);
      finalVerdict = 'warn';
    }
  } else if (policy.verdictMode === 'skip') {
    // Only a verdict that would otherwise NOT have been 'pass' is a downgrade.
    // Recording one for an already-passing review would make a genuine pass
    // indistinguishable from a forced one, which is the defect inverted.
    if (finalVerdict !== 'pass') {
      downgradedFrom = finalVerdict;
      downgradeReason = `verdictMode 'skip' forced pass, overriding verdict '${finalVerdict}'`;
    }
    finalVerdict = 'pass';
  }

  return { verdict: finalVerdict, downgradedFrom, downgradeReason };
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
 * The ONE server-side observation of a story's acceptance-criteria section.
 *
 * THE SEAM. `buildReviewPrompt` renders `text`; `runReview` gates
 * `acCoverage.assessed` on `found`. Both read the SAME observation, so the field
 * the phase-advance gate trusts names the act that was actually performed. A
 * second copy of this regex anywhere in the file would let `assessed` drift from
 * what the reviewer was shown while every test still passed — which is why a
 * durable count assertion pins the regex-literal body at exactly one occurrence.
 *
 * The story note on disk, its frontmatter, or a parsed AC array would all
 * describe something the model never saw. The prompt input is the only thing
 * that makes `assessed` a measurement rather than a claim.
 *
 * `found` requires at least one NON-BLANK line after the heading. The regex
 * happily matches a heading followed immediately by the next `##`, so keying
 * `found` on the match alone would report `assessed: true` for a story whose AC
 * section is empty — the same vacuity the all-empty coverage guard rejects one
 * layer above, arriving underneath it where that guard cannot see it.
 *
 * Returns { text, found }. `text` is exactly what the prompt used to inline, so
 * the rendered prompt is byte-identical for every story that has a section.
 */
/**
 * Where a level-2 section ends: at the next LINE-INITIAL level-2 heading, or at
 * the end of the content.
 *
 * ONE definition, shared by every section extraction in this file. The previous
 * terminator was `(?=##|$)`, which is LEVEL-BLIND: a level-3 subheading begins
 * with two hashes, so the lookahead fired at the first `###` exactly as it would
 * at the next level-2 heading. With a lazy quantifier the match then collapsed to
 * the heading line, and a story whose criteria are organised into subsections
 * extracted to nothing — the reviewer was never shown them, and `found` read
 * false, so the phase-advance gate reported that nothing had been assessed.
 *
 * Requiring a newline before the hashes is what makes it line-initial; requiring
 * a SPACE after exactly two is what makes it level-2 and not level-3 or deeper.
 * `\n` also supplies the separator that a heading directly abutting the previous
 * line still satisfies, so adjacent headings with no blank line between them are
 * handled without demanding one.
 *
 * `$` here means END OF INPUT, and the pattern must never carry the `m` flag.
 * Under `m` the `$` would match before EVERY newline, the lazy quantifier would
 * terminate at the end of the heading line, and the result would be the same
 * empty extraction this fix exists to remove — for every story rather than only
 * subsectioned ones.
 */
const SECTION_TERMINATOR = '(?=\\n## |$)';

/**
 * Extraction pattern for one level-2 section, ANCHORED to the start of the slice
 * it is applied to. It is never run against whole note content — `selectSection`
 * finds the real heading first and applies this to the remainder.
 */
function sectionPattern(heading) {
  return new RegExp(`^## ${heading}[\\s\\S]*?${SECTION_TERMINATOR}`);
}

const AC_SECTION_PATTERN = sectionPattern('Acceptance Criteria');
const TESTING_SECTION_PATTERN = sectionPattern('Testing Requirements');

/**
 * Byte offset of the first REAL level-2 heading with this name, or -1.
 *
 * "Real" means LINE-INITIAL and not inside a fenced code block. The terminator
 * above was already line-anchored; the opener was not, and `String.match` on a
 * non-global pattern returns the first occurrence ANYWHERE. So a mention in
 * prose, in an inline code span, or in a fenced example opened the section and
 * the reviewer was shown text that is not the story's criteria — observed in
 * production, where two bullets of unrelated prose came back as `uncertain`.
 *
 * A line scan rather than a regex because fence membership depends on the lines
 * ABOVE a candidate, which no regex over this input can express.
 *
 * The START is anchored and the END deliberately is not: a heading carrying
 * trailing text after its name is still that heading.
 */
function findSectionStart(content, heading) {
  const lines = content.split('\n');
  const opener = `## ${heading}`;
  let fence = null;
  let offset = 0;
  for (const line of lines) {
    const marker = line.match(/^(```|~~~)/)?.[1];
    if (marker) {
      // Opened by either marker; closed only by the one that opened it.
      if (fence === null) fence = marker;
      else if (marker === fence) fence = null;
    } else if (fence === null && line.startsWith(opener)) {
      return offset;
    }
    offset += line.length + 1;
  }
  return -1;
}

/**
 * The text of one level-2 section, selected from its REAL heading.
 *
 * ONE selector for all three consumer sites — the rendered criteria slot, the
 * gate's `found` observation, and the rendered testing slot. Inlining at any one
 * of them would let the prompt be repaired while the gate still read the wrong
 * text, which is the fail-open surface this exists to close.
 */
function selectSection(content, pattern, heading) {
  if (typeof content !== 'string') return null;
  const start = findSectionStart(content, heading);
  if (start === -1) return null;
  const rest = content.slice(start);
  return rest.match(pattern)?.[0] ?? rest;
}

function extractAcSection(story) {
  const matched = selectSection(story?.content, AC_SECTION_PATTERN, 'Acceptance Criteria');
  if (!matched) return { text: 'Not specified', found: false };
  const body = matched.replace(/^##[^\n]*\n?/, '');
  const found = body.split('\n').some((line) => line.trim().length > 0);
  return { text: matched, found };
}

/**
 * Does the diff under review span this story's whole contribution?
 *
 * THE DEFECT THIS MEASURES. The off-rail reviewer is handed
 * `targetBranch: activeSession.headCommit` — deliberately, one guardrails-off
 * session — so on an amendment ship, or a story built across two sessions, the
 * diff contains only the latest increment. The reviewer then reports criteria
 * satisfied by the EARLIER commits as not-covered, at block severity. Observed
 * in production: five "AC N is not implemented" block findings against a story
 * whose 649-line implementation sat in the immediately preceding commit.
 *
 * MEASURED, NOT ASSUMED. We ask git whether a commit for this story is already
 * reachable from the diff BASE. Off-rail commits carry `Story: <problemId>` in
 * their body, so a hit is direct evidence that earlier work exists behind the
 * base and cannot appear in this diff.
 *
 * The result is required to look like a commit hash rather than merely being
 * non-empty: `--format=%H` returns SHAs, and demanding one keeps this from
 * reading arbitrary command output as a match.
 *
 * FAILS TOWARD NOT-ASSESSABLE. Any ambiguity — a git error, an unreadable
 * result — resolves to partial, because claiming the criteria were assessed on
 * evidence we could not confirm is the intent-sourced status this gate exists to
 * remove. Absent a problemId there is no story and therefore no earlier session
 * to have existed, so that case is NOT partial.
 */
export function isDiffPartialForStory(projectRoot, targetBranch, problemId) {
  if (!problemId || !targetBranch) return false;
  try {
    const found = spawnSync(
      'git',
      ['log', '--format=%H', '-n', '1', `--grep=Story: ${problemId}`, String(targetBranch)],
      { cwd: projectRoot, encoding: 'utf8' },
    );
    if (found.status !== 0) return true;
    const first = (found.stdout || '').trim().split('\n')[0].trim();
    return /^[0-9a-f]{7,40}$/.test(first);
  } catch {
    return true;
  }
}

/**
 * Bind a model-reported acCoverage to the server-side observations.
 *
 * Returns null for anything that is not a usable object, so an absent or
 * malformed coverage report stays absent rather than becoming a half-built one.
 *
 * `assessable` is a SEPARATE fact from `assessed`. `assessed` answers "did the
 * reviewer examine criteria"; `assessable` answers "could this diff have borne
 * on them at all". Collapsing them would make a structurally-unanswerable case
 * indistinguishable from a reviewer that simply produced nothing.
 */
function bindAcAssessment(acCoverage, found, partialDiff = false) {
  if (!acCoverage || typeof acCoverage !== 'object' || Array.isArray(acCoverage)) return null;
  return {
    ...acCoverage,
    assessed: found === true && acCoverage.assessed === true && partialDiff !== true,
    assessable: partialDiff !== true,
  };
}

/**
 * Strip block severity from acceptance-criteria findings the reviewer had no
 * basis to assert.
 *
 * LANDS FIRST, and the ordering is load-bearing. `resolvePhaseAdvanceSuppression`
 * evaluates block-severity findings BEFORE any coverage rule and returns on ANY
 * `severity: "block"` finding regardless of category — so until these are
 * downgraded, the coverage rules are unreachable and no partial-diff state is
 * observable end to end.
 *
 * DOWNGRADED, NOT DROPPED. The observation may still be useful to a reader; what
 * it may not do is carry block severity it cannot support. Every other category
 * is untouched — a security or enforcement finding still blocks.
 */
function softenUnassessableAcFindings(findings, partialDiff) {
  if (partialDiff !== true || !Array.isArray(findings)) return findings;
  return findings.map((f) =>
    f && f.severity === 'block' && f.category === 'ac_coverage'
      ? {
          ...f,
          severity: 'warn',
          message: `${f.message || ''} [downgraded: the diff under review covers only part of this story, so acceptance-criteria coverage was not assessable from it]`.trim(),
        }
      : f,
  );
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
${extractAcSection(story).text}

### Testing Requirements
${selectSection(story.content, TESTING_SECTION_PATTERN, 'Testing Requirements') || 'Not specified'}
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

## How acCoverage Is Used

acCoverage is read as the STORY-COMPLETION SIGNAL. It decides whether the story
is recorded as done, independently of your verdict and of any finding severity.

- Set assessed to false when no acceptance criteria are present in this prompt.
  If the Acceptance Criteria section above reads "Not specified", or is empty,
  there was nothing to assess and assessed MUST be false.
- Do not copy the example object above. It is a shape, not an answer.
- Every notCovered and uncertain entry must QUOTE the acceptance-criterion text
  from this prompt, not paraphrase it, so the entry can be traced back to the
  criterion it names.
- Leave covered empty rather than listing a criterion you did not check.

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
 * Extract the first BALANCED top-level JSON object from a string.
 *
 * Not a regex, deliberately. A finding's `message` is model-authored free text
 * and routinely contains `{`, `}` and escaped quotes, so a naive
 * `slice(indexOf('{'), lastIndexOf('}'))` truncates mid-object on exactly the
 * responses worth salvaging. Tracks string state and backslash escapes so
 * braces inside string literals do not move the depth counter.
 *
 * Returns null when there is no complete object — never throws.
 */
function extractFirstJsonObject(text) {
  const start = text.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escaped) { escaped = false; continue; }
    if (ch === '\\') { if (inString) escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Parse the reviewer's JSON payload out of a raw model response. PURE — no
 * credential, no network, no disk.
 *
 * This is the INVERSE of buildReviewPrompt: the prompt asks for "JSON only",
 * and this tolerates the model's deviation from that instruction. The two are
 * halves of one request/response contract, which is why this must stay in THIS
 * file rather than move to a new module — splitting them lets the prompt drift
 * from the parser with nothing to catch it, and
 * tests/unit/ship-review-fail-closed.test.mjs additionally asserts against the
 * whole source text of review.mjs, so relocating would empty those pins rather
 * than move them. Same precedent, same file: computeFinalVerdict above.
 *
 * Before this existed, callReviewer ran ONE JSON.parse on a fence-stripped
 * string and, on throw, gave up permanently. Three ships lost their review to a
 * response that began "I'll syste..." and then contained the requested object
 * verbatim.
 *
 * Order matters: fence-stripping and a whole-string parse are tried FIRST and
 * unchanged, so every response that parses today still parses byte-identically.
 * Salvage is strictly a fallback.
 *
 * @returns {object|null} the parsed review object, or null when none is present
 */
export function parseReviewerResponse(response) {
  if (typeof response !== 'string' || response.length === 0) return null;

  // Existing behaviour, preserved exactly: handle potential markdown fences.
  const cleaned = response.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
  try {
    const parsed = JSON.parse(cleaned);
    if (parsed && typeof parsed === 'object') return parsed;
  } catch {
    // Not a bare JSON document — fall through to salvage.
  }

  const extracted = extractFirstJsonObject(cleaned);
  if (extracted === null) return null;

  try {
    const parsed = JSON.parse(extracted);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Redact secret-shaped literals out of free text before it is persisted.
 *
 * Scrubbing happens at the PRODUCER (the point rawResponse is constructed),
 * not at the redactReview boundary. redactReview is a shallow spread that
 * promises only findings work, and it is not a chokepoint every path crosses —
 * runOffRailEnforcementGate builds a review-shaped literal by hand and bypasses
 * it entirely. Scrubbing at construction makes the invariant independent of
 * which assembly path runs.
 *
 * Reuses policy.securityPatterns rather than inventing a second regex, so
 * "secret-shaped" has ONE definition in this module. A malformed pattern is
 * skipped rather than allowed to throw on the failure path.
 */
export function scrubSecretLiterals(text, policy = {}) {
  if (typeof text !== 'string' || text.length === 0) return text;

  let scrubbed = text;
  for (const pattern of policy.securityPatterns || []) {
    let regex;
    try {
      regex = new RegExp(pattern, 'gi');
    } catch {
      continue;
    }
    scrubbed = scrubbed.replace(regex, '[REDACTED]');
  }
  return scrubbed;
}

/**
 * The single strict reprompt used when the first response could not be salvaged.
 * Distinguishable from the original prompt so a stubbed transport can tell the
 * two attempts apart.
 */
function buildJsonOnlyRetryPrompt(prompt) {
  return `${prompt}

## RETRY — STRICT OUTPUT CONTRACT

Your previous response could not be parsed as JSON. Respond with the JSON object
ONLY. Do not write a preamble, an explanation, an apology, or a markdown code
fence. The first character of your response must be "{" and the last must be "}".`;
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

    let parsed = parseReviewerResponse(response);
    let lastResponse = response;

    // Exactly ONE strict JSON-only reprompt. Not a loop and not a backoff: both
    // attempts share the single DEFAULT_LLM_TIMEOUT_MS controller armed above,
    // and a retry storm against a degraded model is worse than an advisory skip.
    if (!parsed) {
      lastResponse = await callAnthropicChat({
        client,
        model,
        prompt: buildJsonOnlyRetryPrompt(prompt),
        signal: controller.signal,
      });
      parsed = parseReviewerResponse(lastResponse);
    }

    clearTimeout(timeout);

    if (!parsed) {
      // The reviewer RAN and ANSWERED — it just never produced parseable JSON.
      // That is categorically different from a transport failure, which produced
      // no output at all to salvage, so it carries its own cause rather than
      // collapsing into 'call_failed'. One is a prompt/parser defect and is
      // retryable in band; the other is not.
      //
      // ORDER IS LOAD-BEARING: scrub the FULL response, THEN truncate.
      // Truncating first can cut a credential mid-literal, leaving a fragment
      // the secret pattern no longer matches and which therefore survives
      // scrubbing. Truncation is not redaction.
      return {
        ok: false,
        cause: 'malformed_response',
        error: 'Failed to parse reviewer response after salvage and one strict JSON-only retry',
        rawResponse: scrubSecretLiterals(lastResponse, policy).slice(0, 500),
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
 * The closed vocabulary of `cause`. Three values, each stamped at a distinct
 * callReviewer exit:
 *
 *   not_configured     — no credential; the reviewer was never invoked
 *   call_failed        — the transport threw or aborted; NO output was produced
 *   malformed_response — the reviewer ran and answered, but neither salvage nor
 *                        one strict retry could parse it
 *
 * The last two used to be the same byte, which made a reviewer that answered
 * indistinguishable from one that never ran.
 */
export const RECOGNIZED_CAUSES = ['not_configured', 'call_failed', 'malformed_response'];

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
 * `cause` is a three-value machine-readable discriminator stamped at the callReviewer
 * exit sites, never parsed back out of the free-text error string.
 *
 * @param {object} args
 * @param {string} [args.error]                     underlying reviewer error
 * @param {'not_configured'|'call_failed'|'malformed_response'} [args.cause]
 * @param {Array<{severity?: string}>} [args.patternFindings]
 * @param {string} [args.rawResponse]               scrubbed reviewer output, malformed_response only
 */
export function buildUnavailableReview({ error, cause, patternFindings = [], rawResponse } = {}) {
  const findings = Array.isArray(patternFindings) ? patternFindings : [];
  const hasBlockers = findings.some((f) => f?.severity === 'block');

  return {
    ok: true,
    // Never 'pass'. A blocking pattern finding still blocks; everything else
    // reports the truth, which is that the reviewer was unavailable.
    verdict: hasBlockers ? 'block' : 'unavailable',
    reviewerUnavailable: true,
    llmFailed: true,
    // An ALLOWLIST, not blanket passthrough. `cause` is a discriminator that
    // downstream code branches on, so an arbitrary caller-supplied string must
    // never reach the ship step or telemetry — that is the unvalidated-value
    // shape this field exists to prevent. Widen the vocabulary by one value;
    // do not remove the gate.
    cause: RECOGNIZED_CAUSES.includes(cause) ? cause : 'call_failed',
    error: error || 'Reviewer LLM unavailable',
    summary: error || 'Pattern-based review only (reviewer LLM unavailable)',
    findings,
    // CONDITIONAL: absent, not undefined, when the caller supplied none. A
    // non-malformed unavailable review must gain no new key.
    ...(rawResponse !== undefined ? { rawResponse } : {}),
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
/**
 * Scrub secret-shaped literals out of an acCoverage object.
 *
 * `notCovered` and `uncertain` hold model-authored free text quoting story
 * criteria, and this object now reaches the rks_guardrails_on response, the
 * advance_phase ship step and telemetry — the same sinks the findings canary
 * covers. Reuses scrubSecretLiterals with DEFAULT_SECURITY_PATTERNS so
 * "secret-shaped" keeps ONE definition in this module.
 *
 * Shape is preserved, not normalized: bounding and coercion belong to
 * buildOffRailReviewStep, which owns the payload the step emits. Never mutates
 * its input, and never throws on a malformed one.
 */
function redactAcCoverage(acCoverage) {
  if (!acCoverage || typeof acCoverage !== 'object' || Array.isArray(acCoverage)) return acCoverage;
  const policy = { securityPatterns: DEFAULT_SECURITY_PATTERNS };
  const clean = (value) =>
    Array.isArray(value)
      ? value.map((entry) => (typeof entry === 'string' ? scrubSecretLiterals(entry, policy) : entry))
      : value;
  try {
    return {
      ...acCoverage,
      covered: clean(acCoverage.covered),
      notCovered: clean(acCoverage.notCovered),
      uncertain: clean(acCoverage.uncertain),
    };
  } catch {
    return null;
  }
}

export function redactReview(reviewResult) {
  if (!reviewResult || typeof reviewResult !== 'object') return reviewResult;
  return {
    ...reviewResult,
    findings: redactFindings(reviewResult.findings),
    // CONDITIONAL: a result that carries no acCoverage must not gain the key
    // here. buildOffRailReviewStep emits the key only for a usable object, and
    // an explicitly-undefined key would defeat the in-operator absence check.
    ...(reviewResult.acCoverage !== undefined
      ? { acCoverage: redactAcCoverage(reviewResult.acCoverage) }
      : {}),
  };
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
    // Is this diff even capable of bearing on the story's criteria? Measured
    // once, here, from git — not inferred from the note and not taken from the
    // model. See isDiffPartialForStory.
    const partialDiff = isDiffPartialForStory(projectRoot, targetBranch, problemId);

    // The SAME observation the prompt is built from — read once, here, so the
    // `assessed` flag returned below names what the reviewer was actually shown.
    const acSection = extractAcSection(story);
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
        // Already scrubbed at the producer (callReviewer). Conditional so the
        // not_configured and call_failed results gain no new key.
        ...(llmResult.rawResponse !== undefined ? { rawResponse: llmResult.rawResponse } : {}),
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

    // Determine final verdict based on policy. The single call site of
    // computeFinalVerdict — it returns { verdict, downgradedFrom, downgradeReason }.
    const { verdict: finalVerdict, downgradedFrom, downgradeReason } = computeFinalVerdict({
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
      // Carried alongside `verdict` so the consumer chain
      // (redactReview -> buildOffRailReviewStep -> ship payload) can explain a
      // softened block instead of reporting it as a plain warn. Null when no
      // downgrade occurred.
      downgradedFrom,
      downgradeReason,
      summary: llmResult.summary || `Review complete: ${allFindings.length} finding(s)`,
      findings: softenUnassessableAcFindings(allFindings, partialDiff),
      // ASSESSED IS DERIVED, NOT REPORTED. The model's own `assessed` is
      // byte-identical whether it assessed the criteria or copied the example
      // object out of the prompt, so no assertion on that field alone can tell
      // the two apart. Contradicting it with an independent server-side
      // observation can: when no acceptance criteria reached the prompt, there
      // was nothing to assess and the flag reads false regardless of the claim.
      acCoverage: bindAcAssessment(llmResult.acCoverage, acSection.found, partialDiff),
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
