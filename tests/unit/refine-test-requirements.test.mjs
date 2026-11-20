import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { runRefineTool } from '../../packages/mcp-rks/src/server/refine.mjs';

const TEST_PROJECT_DIR = path.join(process.cwd(), '.tmp-test-refine-reqs');
const NOTES_DIR = path.join(TEST_PROJECT_DIR, 'notes');

describe('Refine Test Requirements', () => {
  beforeEach(() => {
    fs.mkdirSync(NOTES_DIR, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(TEST_PROJECT_DIR, { recursive: true, force: true });
  });

  it('warns when testRequirements missing from frontmatter', async () => {
    const storyContent = `---
id: "backlog.feat.example"
title: "Example Feature"
targetFiles:
  - "src/example.mjs"
---
# Example Feature
## Acceptance Criteria
- [ ] Something works
`;
    fs.writeFileSync(path.join(NOTES_DIR, 'backlog.feat.example.md'), storyContent);

    const result = await runRefineTool({
      projectRoot: TEST_PROJECT_DIR,
      problemId: 'backlog.feat.example',
    });

    expect(result.ok).toBe(true);
    const testSuggestion = result.suggestions.find(s => s.type === 'add_test_requirements');
    expect(testSuggestion).toBeDefined();
    expect(testSuggestion.priority).toBe('high');
  });

  it('warns when testRequirements are too vague', async () => {
    const storyContent = `---
id: "backlog.feat.vague"
title: "Vague Tests"
targetFiles:
  - "src/example.mjs"
testRequirements:
  - "add tests"
  - "verify it works"
---
# Vague Tests
`;
    fs.writeFileSync(path.join(NOTES_DIR, 'backlog.feat.vague.md'), storyContent);

    const result = await runRefineTool({
      projectRoot: TEST_PROJECT_DIR,
      problemId: 'backlog.feat.vague',
    });

    expect(result.ok).toBe(true);
    const vagueSuggestion = result.suggestions.find(s => s.type === 'fix_vague_tests');
    expect(vagueSuggestion).toBeDefined();
    expect(vagueSuggestion.vagueItems).toContain('add tests');
  });

  it('passes when testRequirements are specific', async () => {
    const storyContent = `---
id: "backlog.feat.specific"
title: "Specific Tests"
targetFiles:
  - "src/example.mjs"
testRequirements:
  - "Verify login returns user object when credentials valid"
  - "Test that login throws AuthError when password invalid"
  - "Edge case: empty username returns validation error"
---
# Specific Tests
`;
    fs.writeFileSync(path.join(NOTES_DIR, 'backlog.feat.specific.md'), storyContent);

    const result = await runRefineTool({
      projectRoot: TEST_PROJECT_DIR,
      problemId: 'backlog.feat.specific',
    });

    expect(result.ok).toBe(true);
    expect(result.analysis.hasTestRequirements).toBe(true);
    expect(result.analysis.hasVagueTestRequirements).toBe(false);
    const testSuggestion = result.suggestions.find(s => 
      s.type === 'add_test_requirements' || s.type === 'fix_vague_tests'
    );
    expect(testSuggestion).toBeUndefined();
  });
});