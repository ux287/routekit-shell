import fs from 'fs';
import path from 'path';

// ── Position-preserving mask ────────────────────────────────────────────────────
//
// backlog.fix.test-static-analysis-false-blocks (decision 2026-10-02). Every check
// in this module used to read the RAW source, so a brace inside "})" ended a test
// body early (no_assertions on a test with four expects), a `.toBe(10.22)` inside a
// comment was a critical finding, and the loop detector brace-matched through
// string contents. Every check now runs on ONE masked copy of the source: the
// interior of every string, template and regex literal and every line/block comment
// is replaced by spaces, newlines are kept, and the length is unchanged — so every
// offset and every line number computed on the mask is the same in the original.
// Reported text (test names, snippets) is read from the ORIGINAL at the same offsets.

// A `/` starts a regex literal only after one of these tokens; after anything else
// (an identifier, a number, `)` or `]`) it is division. Conservative on purpose: a
// division mis-read as a regex would blank real code and could hide a violation
// (fail open), so only unambiguous regex positions are masked.
const REGEX_PRECEDING_PUNCT = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^']);
const REGEX_PRECEDING_KEYWORDS = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw',
  'case', 'do', 'else', 'yield', 'await',
]);

/**
 * Mask string/template/regex literal interiors and comments with spaces.
 * Returns a string of identical length with every newline at the same offset.
 * Literal delimiters (quotes, backticks, regex slashes) are kept so the
 * test-header pattern still recognises `it('…', () => {`; `${`/`}` of a template
 * expression are blanked and the expression itself is scanned as code.
 */
export function maskTestSource(content) {
  if (typeof content !== 'string') return content;
  const n = content.length;
  const out = content.split('');
  const blank = (k) => {
    if (k < n && out[k] !== '\n' && out[k] !== '\r') out[k] = ' ';
  };
  // One counter per open template `${` expression: the brace depth inside it.
  const templateStack = [];
  let lastSig = ''; // last significant code character ('' = start of input)
  let lastWord = ''; // the identifier/keyword that lastSig ended, if any

  // Mask template text starting at j (just after an opening backtick or the `}`
  // closing an expression). Returns the index to resume code scanning at.
  const maskTemplateText = (j) => {
    while (j < n) {
      const ch = content[j];
      if (ch === '\\') { blank(j); blank(j + 1); j += 2; continue; }
      if (ch === '`') return j + 1;
      if (ch === '$' && content[j + 1] === '{') {
        blank(j); blank(j + 1);
        templateStack.push(0);
        lastSig = '{'; lastWord = '';
        return j + 2;
      }
      blank(j);
      j++;
    }
    return n;
  };

  // Mask a quoted string starting at its opening quote i. Unterminated strings stop
  // at the newline (JS forbids a raw newline in a quoted string).
  const maskQuoted = (i, q) => {
    let j = i + 1;
    while (j < n) {
      const ch = content[j];
      if (ch === '\\') { blank(j); blank(j + 1); j += 2; continue; }
      if (ch === q) return j + 1;
      if (ch === '\n') return j;
      blank(j);
      j++;
    }
    return n;
  };

  // Index of the closing `/` of a regex literal opening at i, or -1 when the
  // line ends first (then it was not a regex literal).
  const findRegexEnd = (i) => {
    let j = i + 1;
    let inClass = false;
    while (j < n) {
      const ch = content[j];
      if (ch === '\n' || ch === '\r') return -1;
      if (ch === '\\') { j += 2; continue; }
      if (inClass) { if (ch === ']') inClass = false; }
      else if (ch === '[') inClass = true;
      else if (ch === '/') return j;
      j++;
    }
    return -1;
  };

  const regexAllowed = () =>
    lastSig === '' ||
    REGEX_PRECEDING_PUNCT.has(lastSig) ||
    (lastSig === 'a' && REGEX_PRECEDING_KEYWORDS.has(lastWord));

  let i = 0;
  while (i < n) {
    const c = content[i];
    const d = content[i + 1];
    if (c === '/' && d === '/') {
      while (i < n && content[i] !== '\n') { blank(i); i++; }
      continue;
    }
    if (c === '/' && d === '*') {
      blank(i); blank(i + 1); i += 2;
      while (i < n && !(content[i] === '*' && content[i + 1] === '/')) { blank(i); i++; }
      if (i < n) { blank(i); blank(i + 1); i += 2; }
      continue;
    }
    if (c === "'" || c === '"') {
      i = maskQuoted(i, c);
      lastSig = c; lastWord = '';
      continue;
    }
    if (c === '`') {
      i = maskTemplateText(i + 1);
      if (content[i - 1] === '`') { lastSig = '`'; lastWord = ''; }
      continue;
    }
    if (c === '/' && regexAllowed()) {
      const end = findRegexEnd(i);
      if (end !== -1) {
        for (let k = i + 1; k < end; k++) blank(k);
        i = end + 1;
        // A regex literal is a value: a `/` right after it is division.
        lastSig = ')'; lastWord = '';
        continue;
      }
    }
    if (c === '{') {
      if (templateStack.length > 0) templateStack[templateStack.length - 1]++;
      lastSig = c; lastWord = '';
      i++;
      continue;
    }
    if (c === '}') {
      if (templateStack.length > 0) {
        const top = templateStack.length - 1;
        if (templateStack[top] === 0) {
          templateStack.pop();
          blank(i);
          i = maskTemplateText(i + 1);
          if (content[i - 1] === '`') { lastSig = '`'; lastWord = ''; }
          continue;
        }
        templateStack[top]--;
      }
      lastSig = c; lastWord = '';
      i++;
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      let j = i + 1;
      while (j < n && /[\w$]/.test(content[j])) j++;
      // After `.` (including `?.`) a word is a property name, never a keyword:
      // `opts.in / 2` is division (backlog.fix.test-static-analysis-mask-division-as-regex).
      lastWord = lastSig === '.' ? '' : content.slice(i, j);
      lastSig = 'a';
      i = j;
      continue;
    }
    if ((c === '+' || c === '-') && d === c) {
      // `++`/`--` right after a value is postfix, and the result is a value: a `/`
      // after it is division. Otherwise it is prefix and a regex may follow.
      const afterValue =
        lastSig === '0' || lastSig === ')' || lastSig === ']' ||
        lastSig === '`' || lastSig === "'" || lastSig === '"' ||
        (lastSig === 'a' && !REGEX_PRECEDING_KEYWORDS.has(lastWord));
      lastSig = afterValue ? ')' : c; lastWord = '';
      i += 2;
      continue;
    }
    if (/[0-9]/.test(c)) {
      let j = i + 1;
      while (j < n && /[\w.]/.test(content[j])) j++;
      lastSig = '0'; lastWord = '';
      i = j;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }
    lastSig = c; lastWord = '';
    i++;
  }
  return out.join('');
}

/**
 * Find the brace-delimited body ranges of iteration constructs (for/while/forEach) in a test body.
 * Returns an array of [start, end) index pairs. Braceless single-statement loops produce no range
 * (an assertion inside one is rare in generated tests and not worth the false-positive risk) —
 * this exemption is stated in the iteration_only_assertion message so it is discoverable.
 *
 * Pass MASKED text (maskTestSource): brace matching on raw text counts braces inside string,
 * template and regex literals and comments. analyzeTestContent always passes the masked body.
 */
export function findLoopBodyRanges(body) {
  const ranges = [];
  const loopRe = /\b(?:for|while)\s*\(|\.\s*forEach\s*\(/g;
  let m;
  while ((m = loopRe.exec(body)) !== null) {
    // Scan forward to the loop/callback body opener '{'. Stop at ';' (braceless statement).
    let i = m.index + m[0].length;
    while (i < body.length && body[i] !== '{' && body[i] !== ';') i++;
    if (i >= body.length || body[i] !== '{') continue;
    // Brace-match from the opener to find the body end.
    let depth = 0;
    let j = i;
    for (; j < body.length; j++) {
      if (body[j] === '{') depth++;
      else if (body[j] === '}') { depth--; if (depth === 0) { j++; break; } }
    }
    ranges.push([i, j]);
  }
  return ranges;
}

/**
 * True when a test body has at least one assertion and EVERY assertion sits inside an iteration
 * body (no assertion executes outside it). An iteration-internal expect() passes the string-based
 * no_assertions check yet may never run — the collect-then-assert-once pattern (push failures in
 * the loop, expect(failures).toEqual([]) after it) is the correct shape and is NOT flagged.
 */
export function hasLoopOnlyAssertion(testBody) {
  const ranges = findLoopBodyRanges(testBody);
  if (ranges.length === 0) return false;
  const assertRe = /\bexpect\s*\(|\bassert[.(]/g;
  const positions = [];
  let a;
  while ((a = assertRe.exec(testBody)) !== null) positions.push(a.index);
  if (positions.length === 0) return false;
  const insideAnyLoop = (idx) => ranges.some(([s, e]) => idx >= s && idx < e);
  return positions.every(insideAnyLoop);
}

/** Normalise a changed-line entry (Set or array of 1-based line numbers) to a Set, else null. */
function toLineSet(value) {
  if (value == null) return null;
  if (Array.isArray(value)) return new Set(value);
  if (typeof value.has === 'function') return value;
  return null;
}

/** The changed-line set supplied for one file, or null (fail closed) when there is none. */
function changedLinesFor(changedLinesByFile, testFile) {
  if (!changedLinesByFile || typeof changedLinesByFile !== 'object') return null;
  if (changedLinesByFile instanceof Map) return toLineSet(changedLinesByFile.get(testFile));
  if (Object.prototype.hasOwnProperty.call(changedLinesByFile, testFile)) {
    return toLineSet(changedLinesByFile[testFile]);
  }
  return null;
}

/**
 * A finding blocks unless it is OBSERVED to sit outside this run's changes.
 * `changedByThisRun === false` is the only non-blocking state; `null` (no
 * changed-line set supplied) blocks exactly as before this story — fail closed.
 */
function isBlocking(issue) {
  return issue.changedByThisRun !== false;
}

/**
 * Analyze test files for quality issues using static analysis.
 * This is a last-defense layer - catches escapes from earlier quality gates.
 *
 * `changedLinesByFile` (optional): a Map or plain object keyed by the same paths as `testFiles`,
 * each value a Set (or array) of the 1-based line numbers this run added or modified. A critical
 * finding blocks (`ok: false`) only when it sits on a changed line; findings outside the set are
 * still returned, tagged `changedByThisRun: false`. A file with NO entry — or a two-argument
 * call — is analysed whole-file and every critical finding blocks, exactly as before (fail closed).
 */
export function analyzeTestQuality(projectRoot, testFiles, changedLinesByFile = null) {
  const issues = [];
  const warnings = [];

  for (const testFile of testFiles) {
    const fullPath = path.join(projectRoot, testFile);
    if (!fs.existsSync(fullPath)) continue;

    const content = fs.readFileSync(fullPath, 'utf8');
    const perFile = analyzeTestContent(content, testFile, {
      changedLines: changedLinesFor(changedLinesByFile, testFile),
    });
    issues.push(...perFile.issues);
    warnings.push(...perFile.warnings);
  }

  const blockingIssues = issues.filter(isBlocking).length;
  return {
    ok: blockingIssues === 0,
    issues,
    warnings,
    summary: {
      filesAnalyzed: testFiles.length,
      criticalIssues: issues.length,
      // criticalIssues counts every finding, including non-blocking ones on lines
      // this run did not change; blockingIssues is the count that sets ok:false.
      blockingIssues,
      warnings: warnings.length,
    },
  };
}

// ── Changed-line derivation (used by rks_exec Layer D) ─────────────────────────

/** Split file content into lines; a trailing newline does not add an empty line. */
function splitLines(content) {
  const lines = content.split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  if (lines.length === 1 && lines[0] === '') return [];
  return lines;
}

// Upper bound on the LCS table (cells). Past it the diff is not computed and the
// file falls back to whole-file analysis (fail closed, and reported as such).
const MAX_DIFF_CELLS = 16_000_000;

/**
 * The set of 1-based line numbers in `afterContent` that this run added or modified,
 * derived from an observed line diff against `beforeContent` (the pre-apply content).
 *
 * - `{ newFile: true }`: the file did not exist before apply — every line 1..N is changed.
 * - pre-apply or post-apply content not obtainable (not a string), or the diff too
 *   large to compute: returns null — NO set, which analyzeTestQuality treats as fail closed.
 * - A pure deletion marks the line that now follows the deletion point (or the last line),
 *   so removing an assertion from a test still counts as a change to that test.
 */
export function deriveChangedLines(beforeContent, afterContent, { newFile = false } = {}) {
  if (typeof afterContent !== 'string') return null;
  const after = splitLines(afterContent);
  if (newFile) return new Set(after.map((_, k) => k + 1));
  if (typeof beforeContent !== 'string') return null;
  const before = splitLines(beforeContent);

  // Trim the common prefix and suffix; diff only the middle.
  let pre = 0;
  while (pre < before.length && pre < after.length && before[pre] === after[pre]) pre++;
  let suf = 0;
  while (
    suf < before.length - pre && suf < after.length - pre &&
    before[before.length - 1 - suf] === after[after.length - 1 - suf]
  ) suf++;
  const a = before.slice(pre, before.length - suf);
  const b = after.slice(pre, after.length - suf);

  const changed = new Set();
  const deletionGaps = []; // positions in `after` (0-based index of the following line)
  if (a.length === 0 && b.length === 0) return changed;
  if (a.length === 0) {
    b.forEach((_, k) => changed.add(pre + k + 1));
    return changed;
  }
  if (b.length === 0) {
    deletionGaps.push(pre);
  } else {
    const rows = a.length + 1;
    const cols = b.length + 1;
    if (rows * cols > MAX_DIFF_CELLS) return null;
    const table = new Uint32Array(rows * cols);
    for (let i = a.length - 1; i >= 0; i--) {
      for (let j = b.length - 1; j >= 0; j--) {
        table[i * cols + j] = a[i] === b[j]
          ? table[(i + 1) * cols + j + 1] + 1
          : Math.max(table[(i + 1) * cols + j], table[i * cols + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < a.length && j < b.length) {
      if (a[i] === b[j]) { i++; j++; }
      else if (table[(i + 1) * cols + j] >= table[i * cols + j + 1]) { deletionGaps.push(pre + j); i++; }
      else { changed.add(pre + j + 1); j++; }
    }
    while (j < b.length) { changed.add(pre + j + 1); j++; }
    if (i < a.length) deletionGaps.push(pre + j);
  }
  for (const gap of deletionGaps) {
    const prevLine = gap; // 1-based number of the line before the gap
    const nextLine = gap + 1; // 1-based number of the line after the gap
    if (changed.has(prevLine) || changed.has(nextLine)) continue; // part of a modification
    if (nextLine <= after.length) changed.add(nextLine);
    else if (prevLine >= 1) changed.add(prevLine);
  }
  return changed;
}

/**
 * Snapshot the pre-apply state of candidate test files, keyed by the path as given.
 * Each entry is `{ existed: false }` (the file will be created), `{ existed: true, content }`,
 * or `{ existed: true, error }` when it exists but could not be read.
 */
export function capturePreApplyTestSnapshot(projectRoot, files) {
  const snapshot = new Map();
  for (const file of files || []) {
    if (typeof file !== 'string' || !file) continue;
    const fullPath = path.isAbsolute(file) ? file : path.join(projectRoot, file);
    try {
      if (!fs.existsSync(fullPath)) {
        snapshot.set(file, { existed: false });
      } else {
        snapshot.set(file, { existed: true, content: fs.readFileSync(fullPath, 'utf8') });
      }
    } catch (err) {
      snapshot.set(file, { existed: true, error: err?.message || String(err) });
    }
  }
  return snapshot;
}

function snapshotEntryFor(snapshot, file) {
  if (!snapshot || typeof snapshot.get !== 'function') return undefined;
  if (snapshot.has(file)) return snapshot.get(file);
  const norm = path.normalize(file);
  for (const [key, value] of snapshot) {
    if (path.normalize(key) === norm) return value;
  }
  return undefined;
}

/**
 * For each applied test file, derive its changed-line set from the pre-apply snapshot and the
 * current (post-apply) content. A file whose set cannot be derived (no snapshot entry, unreadable
 * before or after, diff too large) gets NO entry and is listed in wholeFileFallbackFiles.
 */
export function deriveChangedLinesForFiles(projectRoot, testFiles, preApplySnapshot) {
  const changedLinesByFile = new Map();
  const wholeFileFallbackFiles = [];
  for (const file of testFiles || []) {
    const entry = snapshotEntryFor(preApplySnapshot, file);
    let afterContent = null;
    try {
      afterContent = fs.readFileSync(path.join(projectRoot, file), 'utf8');
    } catch {
      afterContent = null;
    }
    let set = null;
    if (entry && afterContent !== null) {
      if (entry.existed === false) set = deriveChangedLines(null, afterContent, { newFile: true });
      else set = deriveChangedLines(entry.content, afterContent);
    }
    if (set) changedLinesByFile.set(file, set);
    else wholeFileFallbackFiles.push(file);
  }
  return { changedLinesByFile, wholeFileFallbackFiles };
}

/**
 * Build the `staticAnalysis` report rks_exec Layer D returns, and console.warn what the gate
 * passed (ARCH R9, decision 2026-10-03): each whole-file fallback file, and each non-blocking
 * issue (a finding observed on a line this run did not change). Both arrays are always present.
 */
export function buildStaticAnalysisReport(staticResult, wholeFileFallbackFiles = [], { warn = console.warn } = {}) {
  const fallbacks = Array.isArray(wholeFileFallbackFiles) ? [...wholeFileFallbackFiles] : [];
  const issues = Array.isArray(staticResult?.issues) ? staticResult.issues : [];
  const nonBlockingIssues = issues.filter((issue) => !isBlocking(issue));
  for (const file of fallbacks) {
    warn(`[rks.exec] Static analysis: ${file} fell back to whole-file analysis (changed lines could not be derived) — every finding in it blocks`);
  }
  for (const issue of nonBlockingIssues) {
    warn(`[rks.exec] Static analysis non-blocking issue (line not changed by this run): ${issue.file}:${issue.line} ${issue.type}`);
  }
  return { nonBlockingIssues, wholeFileFallbackFiles: fallbacks };
}

/**
 * Run the test-quality checks over an in-memory test file string. This is the shared surface
 * the planner's pre-emit self-check reuses so it returns the same verdict analyzeTestQuality
 * would — the planner never emits a test its own gate would reject. `fileLabel` is used only for
 * the `file` field on findings.
 */
/**
 * 1-based line number of a character offset.
 *
 * backlog.feat.intervention-receipts-at-forced-exit-paths. Every issue this
 * module raised named a FILE and nothing else — no line, and for two of the six
 * types no snippet either. The operator was told a rule fired somewhere in a
 * file and had to grep to find where, on every gate failure. Location is
 * computed from the match offset, so it is measured rather than guessed.
 */
function lineAt(content, index) {
  if (typeof index !== 'number' || index < 0) return 1;
  let line = 1;
  for (let i = 0; i < index && i < content.length; i++) {
    if (content[i] === '\n') line++;
  }
  return line;
}

/** The offending text at an offset, bounded and single-line. */
function snippetAt(content, index, fallback = '') {
  if (typeof index !== 'number' || index < 0) return fallback;
  const end = content.indexOf('\n', index);
  const raw = content.slice(index, end === -1 ? content.length : end).trim();
  return (raw || fallback).slice(0, 80);
}

/**
 * Whether an issue sits on a line this run changed.
 *
 * `null` — NOT `false` — when the changed-line set was not supplied. Returning
 * false there would assert "this code is pre-existing" without observing it,
 * which is the intent-sourced-status defect design.evidence-bound-reporting-invariant
 * prohibits. The caller that knows the changed set is the only one that can
 * answer, and it does not always know.
 *
 * With `endLine`, a finding about a whole construct (a test) counts as changed
 * when ANY line of it changed — editing a test's body changes that test even
 * though the finding is reported at its header line.
 */
function changedFlag(changedLines, line, endLine = line) {
  if (!changedLines || typeof changedLines.has !== 'function') return null;
  for (let l = line; l <= endLine; l++) {
    if (changedLines.has(l)) return true;
  }
  return false;
}

// expect(<numeric literal>) [.not] immediately before a `.toBe(` match.
const NUMERIC_LITERAL_LHS = /\bexpect\s*\(\s*[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?\s*\)(?:\s*\.\s*not)?\s*$/;

export function analyzeTestContent(content, fileLabel = '<generated>', { changedLines = null } = {}) {
  const issues = [];
  const warnings = [];
  if (!content || typeof content !== 'string') {
    return { ok: true, issues, warnings };
  }
  changedLines = toLineSet(changedLines);

  // Every check runs on the masked copy; reported text comes from `content`.
  const masked = maskTestSource(content);

  // Pattern: Empty test bodies
  const emptyTestPattern = /(?:it|test)\s*\(\s*['"`][^'"`]+['"`]\s*,\s*(?:async\s*)?\(\s*\)\s*=>\s*\{\s*\}\s*\)/g;
  // exec, not match: String.match with /g returns the matched TEXT and discards
  // every offset, so a line number is unrecoverable from it.
  let emptyMatch;
  while ((emptyMatch = emptyTestPattern.exec(masked)) !== null) {
    const line = lineAt(masked, emptyMatch.index);
    const endLine = lineAt(masked, emptyMatch.index + emptyMatch[0].length - 1);
    issues.push({
      file: fileLabel,
      line,
      changedByThisRun: changedFlag(changedLines, line, endLine),
      type: 'empty_test',
      severity: 'critical',
      message: 'Empty test body - test does nothing',
      snippet: content.slice(emptyMatch.index, emptyMatch.index + emptyMatch[0].length).slice(0, 80),
    });
  }

  // Pattern: No assertions
  // Find test blocks using brace-depth counting (on the mask) to handle nested structures
  const testHeaderPattern = /(?:it|test)\s*\(\s*['"`]([^'"`]+)['"`]\s*,\s*(?:async\s*)?\([^)]*\)\s*=>\s*\{/dg;
  let headerMatch;
  while ((headerMatch = testHeaderPattern.exec(masked)) !== null) {
    const [nameStart, nameEnd] = headerMatch.indices[1];
    const testName = content.slice(nameStart, nameEnd);
    const headerLine = lineAt(masked, headerMatch.index);
    const bodyStart = headerMatch.index + headerMatch[0].length;
    // Extract full test body by counting brace depth
    let depth = 1;
    let pos = bodyStart;
    while (pos < masked.length && depth > 0) {
      if (masked[pos] === '{') depth++;
      else if (masked[pos] === '}') depth--;
      pos++;
    }
    const testBody = masked.slice(bodyStart, pos - 1);
    const endLine = lineAt(masked, Math.max(bodyStart, pos - 1));
    const testChanged = changedFlag(changedLines, headerLine, endLine);

    // Check for assertions
    const hasExpect = /expect\s*\(/.test(testBody);
    const hasAssert = /assert[\.(]/.test(testBody);
    const hasThrow = /toThrow|rejects/.test(testBody);

    if (!hasExpect && !hasAssert && !hasThrow) {
      issues.push({
        file: fileLabel,
        line: headerLine,
        changedByThisRun: testChanged,
        type: 'no_assertions',
        severity: 'critical',
        message: `Test "${testName}" has no assertions`,
        snippet: snippetAt(content, headerMatch.index, `it("${testName}")`),
        testName,
      });
    } else if (hasLoopOnlyAssertion(testBody)) {
      // Assertion(s) exist but ALL sit inside an iteration body — may never execute on an empty
      // collection (the observed bug: a loop-body test with no executing assertion). Collect
      // failures in the loop and assert once outside it (expect(failures).toEqual([])).
      issues.push({
        file: fileLabel,
        line: headerLine,
        changedByThisRun: testChanged,
        type: 'iteration_only_assertion',
        severity: 'critical',
        snippet: snippetAt(content, headerMatch.index, `it("${testName}")`),
        message: `Test "${testName}" only asserts inside the braced body of an iteration construct (for, while, or a .forEach callback) — it may never execute on an empty collection. Collect failures in the loop and assert once outside it (e.g. expect(failures).toEqual([])). An iteration body without braces (a single-statement loop) is exempt from this check.`,
        testName,
      });
    }

    // Warning: Single assertion
    const assertionCount = (testBody.match(/expect\s*\(/g) || []).length +
                          (testBody.match(/assert[\.(]/g) || []).length;
    if (assertionCount === 1) {
      warnings.push({
        file: fileLabel,
        line: headerLine,
        changedByThisRun: testChanged,
        type: 'single_assertion',
        severity: 'warning',
        message: `Test "${testName}" has only 1 assertion`,
        snippet: snippetAt(content, headerMatch.index, `it("${testName}")`),
        testName,
      });
    }
  }

  // Pattern: Exact-float equality — expect(x).toBe(10.22) on a computed value is fragile
  // (floating-point equality). Only non-integer decimal literals trigger; integer .toBe(3) is
  // exempt, and so is a NUMERIC-LITERAL left-hand side (expect(1.5).toBe(1.5) compares two
  // literals and is not fragile). A named constant on the left still fires (decision 2026-10-02).
  // Runs on the mask, so a .toBe(10.22) inside a comment or string is not a finding.
  const floatEqPattern = /\.toBe\(\s*(-?(?:\d+\.\d+|\.\d+))\s*\)/g;
  let floatMatch;
  while ((floatMatch = floatEqPattern.exec(masked)) !== null) {
    const lhsWindow = masked.slice(Math.max(0, floatMatch.index - 200), floatMatch.index);
    if (NUMERIC_LITERAL_LHS.test(lhsWindow)) continue;
    const literal = floatMatch[1];
    const precision = (literal.split('.')[1] || '').length;
    const floatLine = lineAt(masked, floatMatch.index);
    issues.push({
      file: fileLabel,
      line: floatLine,
      changedByThisRun: changedFlag(changedLines, floatLine),
      type: 'float_exact_equality',
      severity: 'critical',
      message: `Exact-float equality expect(...).toBe(${literal}) is fragile for computed values — use toBeCloseTo(${literal}, ${precision}) instead (precision ${precision} = the literal's decimal places).`,
      snippet: content.slice(floatMatch.index, floatMatch.index + floatMatch[0].length),
    });
  }

  // Pattern: Mock-only tests (calls mock but never asserts result)
  const mockPattern = /vi\.fn\(\)|jest\.fn\(\)|sinon\.stub\(\)/g;
  const firstMock = mockPattern.exec(masked);
  if (firstMock) {
    const mockLine = lineAt(masked, firstMock.index);
    // Check if mocks are verified
    const hasVerification = /toHaveBeenCalled|calledWith|toHaveBeenCalledWith|called\b/.test(masked);
    const hasResultAssertion = /expect\([^)]*\)\.(?:toBe|toEqual|toMatch|toContain|toBeDefined)/.test(masked);

    if (!hasVerification && !hasResultAssertion) {
      warnings.push({
        file: fileLabel,
        line: mockLine,
        changedByThisRun: changedFlag(changedLines, mockLine),
        type: 'unverified_mocks',
        severity: 'warning',
        message: 'Tests use mocks but may not verify behavior',
        snippet: snippetAt(content, firstMock.index, firstMock[0]),
      });
    }
  }

  return { ok: issues.filter(isBlocking).length === 0, issues, warnings };
}
