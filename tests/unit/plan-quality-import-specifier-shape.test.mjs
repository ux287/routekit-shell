import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { reviewPlan } from '../../packages/mcp-rks/src/server/plan-quality.mjs';

// backlog.fix.import-specifier-extraction-overcaptures
//
// A field report from routekit-growth: rks_plan returned zero executable steps in
// 3 seconds with a single error — check `import_not_declared`, package `", "`,
// specifier `", "`. Two characters: a comma and a space. `failureClass` was
// `output_invalid`, which the Build prompt treats as a hard stop, so the story
// could not ship.
//
// Cause: the ESM pattern in extractImportedSpecifiers lacked the `\b` its two
// sibling patterns carry, and nothing validated the captured string's shape. So a
// match could begin at an `import` substring inside a word, or at a standalone
// `import` token in PROSE, and run to an unrelated quoted pair.
//
// EVERY FIXTURE BELOW DECLARES A DEPENDENCY. checkImportGrounding skips a step
// entirely when the merged manifest is empty (readPackageDependenciesForFile
// returns null), so an "expect no finding" assertion against a dependency-free
// fixture passes against a dead code path and witnesses nothing.

let root;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'rks-spec-shape-')); });
afterEach(() => { if (root) fs.rmSync(root, { recursive: true, force: true }); });

function writePkg(deps = {}, devDeps = {}) {
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'fixture', version: '1.0.0', dependencies: deps, devDependencies: devDeps }, null, 2),
  );
}

const createStep = (target, content) => ({ action: 'create_file', path: target, content });
const importIssues = (r) => (r.errors || []).filter((e) => e.check === 'import_not_declared');

describe('extractImportedSpecifiers — captures that are not specifiers are dropped', () => {
  // RED BEFORE THE FIX. The standalone `import` token survives a \b anchor;
  // `[\w*{}\s,]+` backtracks to `them, copy`, `\s+from\s+` consumes ` from `, and
  // the capture is the two-character `, `. The shape guard is its only remedy.
  // This is the field report reproduced verbatim.
  it('yields no finding for a prose line whose from-clause quotes a separator', async () => {
    writePkg({}, { vitest: '^2.1.9' });
    const content = "Do not import them, copy from ', ' instead.";
    const r = await reviewPlan({ projectRoot: root, plan: { steps: [createStep('docs/NOTES.md', content)] } });
    expect(importIssues(r)).toEqual([]);
  });

  // RED BEFORE THE FIX, for the OTHER reason. The current pattern matches at the
  // `import` inside `reimport`, backtracks `[\w*{}\s,]+` to `}`, consumes ` from `
  // and captures `x`. The \b anchor kills it; the shape guard would not, since
  // `x` is a perfectly well-formed specifier.
  it('yields no finding for an `import` substring inside a longer identifier', async () => {
    writePkg({}, { vitest: '^2.1.9' });
    const content = "export { reimport } from 'x';";
    const r = await reviewPlan({ projectRoot: root, plan: { steps: [createStep('src/a.mjs', content)] } });
    expect(importIssues(r)).toEqual([]);
  });

  // Universal property, made non-vacuous: the finding set must be NON-EMPTY, so
  // the loop cannot pass by iterating nothing.
  it('never reports a specifier containing whitespace or a comma, while still reporting real ones', async () => {
    writePkg({}, { vitest: '^2.1.9' });
    const content = [
      "import realThing from 'graceful-fs';",
      "Do not import them, copy from ', ' instead.",
    ].join('\n');
    const r = await reviewPlan({ projectRoot: root, plan: { steps: [createStep('src/b.mjs', content)] } });

    const issues = importIssues(r);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.map((i) => i.specifier)).toContain('graceful-fs');
    for (const issue of issues) {
      expect(String(issue.specifier ?? ''), 'specifier').not.toMatch(/[\s,]/);
      expect(String(issue.package ?? ''), 'package').not.toMatch(/[\s,]/);
    }
  });
});

describe('the guard must not blind the check', () => {
  it('still reports a genuinely undeclared third-party import', async () => {
    writePkg({}, { vitest: '^2.1.9' });
    const content = "import userEvent from '@testing-library/user-event';";
    const r = await reviewPlan({ projectRoot: root, plan: { steps: [createStep('src/c.test.mjs', content)] } });
    expect(importIssues(r).map((i) => i.specifier)).toContain('@testing-library/user-event');
  });

  // An over-strict "bare or scoped package name" regex rejects all of these, which
  // would silently blind the check — reviewPlan returns ok and the undeclared
  // import surfaces at exec instead.
  it.each([
    ['dotted name', 'chart.js'],
    ['dotted name, second form', 'lodash.merge'],
    ['nested subpath', 'react-dom/client'],
    ['extensioned subpath', 'some-pkg/dist/style.css'],
    ['uppercase legacy name', 'JSONStream'],
    // backlog.fix.module-specifier-scoped-uppercase. The bare branch already
    // admitted uppercase — which is why JSONStream above passed and the asymmetry
    // survived unnoticed. The SCOPE branch did not, so an uppercase-scoped package
    // was dropped silently and its undeclared import surfaced at exec instead of
    // in review. That is the "guard must not blind the check" failure inverted.
    ['uppercase scope', '@ACME/utils'],
    ['uppercase scope and name', '@ACME/JSONStream'],
    ['scoped subpath', '@scope/pkg/sub'],
  ])('still reports an undeclared %s', async (_label, spec) => {
    writePkg({}, { vitest: '^2.1.9' });
    const content = `import thing from '${spec}';`;
    const r = await reviewPlan({ projectRoot: root, plan: { steps: [createStep('src/d.mjs', content)] } });
    expect(importIssues(r).map((i) => i.specifier)).toContain(spec);
  });

  it('reports an uppercase scope identically to its lowercase twin', async () => {
    // The defect was a case asymmetry between the two branches of one regex, so the
    // invariant is that case cannot change the verdict — asserted as a pair rather
    // than as two independent rows, which would pass even if only one branch worked.
    writePkg({}, { vitest: '^2.1.9' });
    const lower = await reviewPlan({
      projectRoot: root,
      plan: { steps: [createStep('src/l.mjs', "import a from '@acme/utils';")] },
    });
    const upper = await reviewPlan({
      projectRoot: root,
      plan: { steps: [createStep('src/u.mjs', "import a from '@ACME/utils';")] },
    });
    expect(importIssues(lower).map((i) => i.specifier)).toContain('@acme/utils');
    expect(importIssues(upper).map((i) => i.specifier)).toContain('@ACME/utils');
    expect(importIssues(upper).length).toBe(importIssues(lower).length);
  });

  it('reports every declared-set miss across the enumerated ESM forms', async () => {
    writePkg({}, { vitest: '^2.1.9' });
    const content = [
      "import a from 'undeclared-default';",
      "import { b } from 'undeclared-named';",
      "import * as c from 'undeclared-namespace';",
      "import 'undeclared-sideeffect';",
      "const d = await import('undeclared-dynamic');",
      "const e = require('undeclared-require');",
    ].join('\n');
    const r = await reviewPlan({ projectRoot: root, plan: { steps: [createStep('src/e.mjs', content)] } });

    const seen = importIssues(r).map((i) => i.specifier);
    for (const spec of [
      'undeclared-default', 'undeclared-named', 'undeclared-namespace',
      'undeclared-sideeffect', 'undeclared-dynamic', 'undeclared-require',
    ]) {
      expect(seen, spec).toContain(spec);
    }
  });
});

describe('the guard does not take over the call site\'s skip decisions', () => {
  it.each([
    ['relative', './local-module'],
    ['parent-relative', '../sibling/mod'],
    ['absolute', '/abs/path/mod'],
    ['node: builtin', 'node:fs'],
    ['bare builtin', 'fs'],
  ])('%s specifiers still produce no finding', async (_label, spec) => {
    writePkg({}, { vitest: '^2.1.9' });
    const content = `import thing from '${spec}';`;
    const r = await reviewPlan({ projectRoot: root, plan: { steps: [createStep('src/f.mjs', content)] } });
    expect(importIssues(r)).toEqual([]);
  });

  it('does not flag a declared package', async () => {
    writePkg({}, { vitest: '^2.1.9', 'graceful-fs': '^4.0.0' });
    const content = "import g from 'graceful-fs';";
    const r = await reviewPlan({ projectRoot: root, plan: { steps: [createStep('src/g.mjs', content)] } });
    expect(importIssues(r)).toEqual([]);
  });
});

describe('bare @-prefixed aliases are dropped — a deliberate behaviour change', () => {
  // Neither is installable, so import_not_declared's own prescribed remedy —
  // declare it, or emit a dependency-add step — cannot be performed. A finding
  // whose only remedy is impossible is a false positive of the family this closes.
  it.each([
    ['path alias', '@/components/Button'],
    ['scope-only', '@foo'],
    ['protocol-prefixed', 'https://cdn.example/x.js'],
  ])('%s produces no finding', async (_label, spec) => {
    writePkg({}, { vitest: '^2.1.9' });
    const content = `import thing from '${spec}';`;
    const r = await reviewPlan({ projectRoot: root, plan: { steps: [createStep('src/h.mjs', content)] } });
    expect(importIssues(r)).toEqual([]);
  });
});

describe('malformed scope segments are refused at the edited position', () => {
  // These are ABSENCE assertions and must not live in the presence table above —
  // a row there would assert the specifier IS reported, go red once the fix is
  // correct, and make loosening the scope class the cheapest route back to green.
  //
  // `@.bad/utils` is the discriminating control for THIS fix: it clears the
  // whitespace clause, is not caught by the relative/absolute clause (it starts
  // with `@`, not `.`), reaches the base-name regex, and is decided solely by the
  // scope alternative's first-character class — the exact class this story edits.
  // A dot is absent from both the old and the new class, so it stays refused; it
  // reddens only if that class is loosened.
  it.each([
    ['leading dot in the scope segment', '@.bad/utils'],
    ['whitespace in the specifier', 'has space/pkg'],
  ])('%s produces no finding', async (_label, spec) => {
    // The manifest MUST declare something: checkImportGrounding skips the step
    // entirely on an empty merged manifest, and an absence assertion against a
    // skipped step passes without exercising the guard at all.
    writePkg({}, { vitest: '^2.1.9' });
    const r = await reviewPlan({
      projectRoot: root,
      plan: { steps: [createStep('src/m.mjs', `import thing from '${spec}';`)] },
    });
    expect(importIssues(r)).toEqual([]);
  });
});
