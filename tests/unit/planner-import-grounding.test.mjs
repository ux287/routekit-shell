import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { reviewPlan } from '../../packages/mcp-rks/src/server/plan-quality.mjs';
import { formatDependenciesForPrompt, readPackageDependencies } from '../../packages/mcp-rks/src/server/planner-prompts.mjs';

// backlog.fix.planner-ground-imports-in-package-json
// The planner emitted `import userEvent from '@testing-library/user-event'` — a package absent
// from package.json — so vitest module resolution failed and 0 tests ran. reviewPlan() now flags
// any generated import whose base package is neither declared in package.json (deps + devDeps),
// a Node built-in, a relative path, nor covered by an explicit dependency-add step in the plan.

let root;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'rks-import-grounding-')); });
afterEach(() => { if (root) fs.rmSync(root, { recursive: true, force: true }); });

// Fixture package.json declaring ONLY @testing-library/react + jest-dom (the observed clean-machine set).
function writePkg(deps = {}, devDeps = {}) {
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'fixture', version: '1.0.0', dependencies: deps, devDependencies: devDeps }, null, 2),
  );
}

const createStep = (target, content) => ({ action: 'create_file', path: target, content });
const findImportIssue = (r) => (r.errors || []).find((e) => e.check === 'import_not_declared');

describe('reviewPlan — import grounding (undeclared package detection)', () => {
  it('ERROR PATH (observed bug): flags `@testing-library/user-event` when only react + jest-dom are declared', async () => {
    writePkg({}, { '@testing-library/react': '^16.0.1', '@testing-library/jest-dom': '^6.5.0' });
    const content = [
      "import { render, screen } from '@testing-library/react';",
      "import userEvent from '@testing-library/user-event';",
      "import Keypad from './Keypad';",
      "test('renders', () => { render(<Keypad />); });",
    ].join('\n');
    const plan = { steps: [createStep('src/Keypad.test.tsx', content)] };

    const r = await reviewPlan({ projectRoot: root, plan });
    expect(r.ok).toBe(false);
    const issue = findImportIssue(r);
    expect(issue, 'expected an import_not_declared error').toBeTruthy();
  });

  it('ERROR PATH: the error identifies the offending package name and the target file, surfaced via ok:false', async () => {
    writePkg({}, { '@testing-library/react': '^16.0.1', '@testing-library/jest-dom': '^6.5.0' });
    const plan = { steps: [createStep('src/Keypad.test.tsx', "import userEvent from '@testing-library/user-event';")] };

    const r = await reviewPlan({ projectRoot: root, plan });
    expect(r.ok).toBe(false); // surfaced by plan-review, not passed to exec
    const issue = findImportIssue(r);
    expect(issue.package).toBe('@testing-library/user-event');
    expect(issue.file).toBe('src/Keypad.test.tsx');
    expect(issue.message).toContain('@testing-library/user-event');
    expect(issue.message).toContain('src/Keypad.test.tsx');
  });

  it('HAPPY PATH: imports of declared dependencies are NOT flagged', async () => {
    writePkg({ react: '^18.2.0', lodash: '^4.17.21' }, {});
    const content = [
      "import React from 'react';",
      "import { merge } from 'lodash';",
    ].join('\n');
    const plan = { steps: [createStep('src/App.tsx', content)] };

    const r = await reviewPlan({ projectRoot: root, plan });
    expect(findImportIssue(r)).toBeFalsy();
  });

  it('HAPPY PATH: a package present only in devDependencies is NOT flagged', async () => {
    writePkg({}, { '@testing-library/react': '^16.0.1' });
    const plan = { steps: [createStep('src/App.test.tsx', "import { render } from '@testing-library/react';")] };

    const r = await reviewPlan({ projectRoot: root, plan });
    expect(findImportIssue(r)).toBeFalsy();
  });

  it('HAPPY PATH: Node built-in modules are NOT flagged despite absence from package.json', async () => {
    writePkg({ react: '^18.2.0' }, {});
    const content = [
      "import fs from 'fs';",
      "import path from 'node:path';",
      "import { pipeline } from 'stream/promises';",
    ].join('\n');
    const plan = { steps: [createStep('scripts/tool.mjs', content)] };

    const r = await reviewPlan({ projectRoot: root, plan });
    expect(findImportIssue(r)).toBeFalsy();
  });

  it('HAPPY PATH: relative/local imports are NOT flagged', async () => {
    writePkg({ react: '^18.2.0' }, {});
    const content = [
      "import Keypad from './Keypad';",
      "import { format } from '../utils/format';",
    ].join('\n');
    const plan = { steps: [createStep('src/App.tsx', content)] };

    const r = await reviewPlan({ projectRoot: root, plan });
    expect(findImportIssue(r)).toBeFalsy();
  });

  it('HAPPY PATH: subpath specifiers resolve to their base package for the lookup', async () => {
    writePkg({ lodash: '^4.17.21' }, { '@testing-library/react': '^16.0.1' });
    const content = [
      "import { renderHook } from '@testing-library/react/pure';",
      "import merge from 'lodash/merge';",
    ].join('\n');
    const plan = { steps: [createStep('src/App.test.tsx', content)] };

    const r = await reviewPlan({ projectRoot: root, plan });
    expect(findImportIssue(r)).toBeFalsy();
  });

  it('HAPPY PATH: an explicit dependency-add step (npm install run_command) suppresses the flag', async () => {
    writePkg({}, { '@testing-library/react': '^16.0.1' });
    const plan = { steps: [
      { action: 'run_command', command: 'npm install --save-dev @testing-library/user-event@^14.5.2' },
      createStep('src/Keypad.test.tsx', "import userEvent from '@testing-library/user-event';"),
    ] };

    const r = await reviewPlan({ projectRoot: root, plan });
    expect(findImportIssue(r)).toBeFalsy();
  });

  it('HAPPY PATH: an explicit dependency-add step (package.json edit) suppresses the flag', async () => {
    writePkg({}, { '@testing-library/react': '^16.0.1' });
    const plan = { steps: [
      { action: 'search_replace', path: 'package.json', edits: [{
        search: '"@testing-library/react": "^16.0.1"',
        replace: '"@testing-library/react": "^16.0.1",\n    "@testing-library/user-event": "^14.5.2"',
      }] },
      createStep('src/Keypad.test.tsx', "import userEvent from '@testing-library/user-event';"),
    ] };

    const r = await reviewPlan({ projectRoot: root, plan });
    expect(findImportIssue(r)).toBeFalsy();
  });

  it('GROUNDING: formatDependenciesForPrompt lists declared package names and the import directive', () => {
    writePkg({ react: '^18.2.0' }, { '@testing-library/react': '^16.0.1' });
    const deps = readPackageDependencies(root);
    const sections = formatDependenciesForPrompt(deps);
    const text = sections.join('\n');
    expect(text).toContain('react');
    expect(text).toContain('@testing-library/react');
    expect(text).toMatch(/Only import packages listed above/i);
    expect(text).toMatch(/dependency-add step/i);
  });

  it('NO-OP SAFETY: no package.json → import grounding is a safe no-op', async () => {
    // root has no package.json
    const plan = { steps: [createStep('src/Keypad.test.tsx', "import userEvent from '@testing-library/user-event';")] };
    const r = await reviewPlan({ projectRoot: root, plan });
    expect(findImportIssue(r)).toBeFalsy();
  });

  it('NO-OP SAFETY: malformed/invalid-JSON package.json is handled gracefully (no throw, no false positive)', async () => {
    fs.writeFileSync(path.join(root, 'package.json'), '{ this is not valid json ');
    const plan = { steps: [createStep('src/Keypad.test.tsx', "import userEvent from '@testing-library/user-event';")] };
    let r;
    expect(() => { r = reviewPlan({ projectRoot: root, plan }); }).not.toThrow();
    r = await r;
    expect(findImportIssue(r)).toBeFalsy();
  });

  it('REGRESSION: a plan whose imports are all declared yields no import_not_declared error', async () => {
    writePkg({ react: '^18.2.0' }, { '@testing-library/react': '^16.0.1', '@testing-library/jest-dom': '^6.5.0' });
    const content = [
      "import React from 'react';",
      "import { render, screen } from '@testing-library/react';",
      "import '@testing-library/jest-dom';",
      "import Keypad from './Keypad';",
    ].join('\n');
    const plan = { steps: [createStep('src/Keypad.test.tsx', content)] };

    const r = await reviewPlan({ projectRoot: root, plan });
    expect((r.errors || []).some((e) => e.check === 'import_not_declared')).toBe(false);
  });
});
