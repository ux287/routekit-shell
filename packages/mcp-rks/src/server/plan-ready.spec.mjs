import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';

// Mock fs
vi.mock('fs');
vi.mock('path', async () => {
  const actual = await vi.importActual('path');
  return { ...actual, resolve: vi.fn((...args) => args.join('/')) };
});

describe('runPlanReadyTool - Testing Requirements validation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const mockStoryWithTestingRequirements = `---
id: test-story
title: Test Story
phase: ready
targetFiles:
  - src/example.js
---

# Test Story

## Problem
Something is broken.

## Goal
Fix it.

## Target Files
src/example.js

## Acceptance Criteria
- [ ] Thing works

## Testing Requirements
- [ ] Unit test for thing
`;

  const mockStoryWithTestCases = `---
id: test-story
title: Test Story
phase: ready
targetFiles:
  - src/example.js
---

# Test Story

## Problem
Something is broken.

## Goal
Fix it.

## Target Files
src/example.js

## Acceptance Criteria
- [ ] Thing works

## Test Cases
- [ ] Unit test for thing
`;

  const mockStoryWithoutTestingSection = `---
id: test-story
title: Test Story
phase: ready
targetFiles:
  - src/example.js
---

# Test Story

## Problem
Something is broken.

## Goal
Fix it.

## Target Files
src/example.js

## Acceptance Criteria
- [ ] Thing works
`;

  it('passes validation when story has Testing Requirements section', async () => {
    fs.existsSync.mockImplementation((p) => {
      if (p.includes('test-story.md')) return true;
      if (p.includes('example.js')) return true;
      return false;
    });
    fs.readFileSync.mockReturnValue(mockStoryWithTestingRequirements);

    const { runPlanReadyTool } = await import('./plan-ready.mjs');
    const result = await runPlanReadyTool({
      projectId: 'test',
      problemId: 'test-story',
      projectRoot: '/test/project'
    });

    const testingIssue = result.issues?.find(i => i.check === 'missing_testing_requirements');
    expect(testingIssue).toBeUndefined();
  });

  it('passes validation when story has Test Cases section (backwards compat)', async () => {
    fs.existsSync.mockImplementation((p) => {
      if (p.includes('test-story.md')) return true;
      if (p.includes('example.js')) return true;
      return false;
    });
    fs.readFileSync.mockReturnValue(mockStoryWithTestCases);

    const { runPlanReadyTool } = await import('./plan-ready.mjs');
    const result = await runPlanReadyTool({
      projectId: 'test',
      problemId: 'test-story',
      projectRoot: '/test/project'
    });

    const testingIssue = result.issues?.find(i => i.check === 'missing_testing_requirements');
    expect(testingIssue).toBeUndefined();
  });

  it('fails validation when story lacks testing section', async () => {
    fs.existsSync.mockImplementation((p) => {
      if (p.includes('test-story.md')) return true;
      if (p.includes('example.js')) return true;
      return false;
    });
    fs.readFileSync.mockReturnValue(mockStoryWithoutTestingSection);

    const { runPlanReadyTool } = await import('./plan-ready.mjs');
    const result = await runPlanReadyTool({
      projectId: 'test',
      problemId: 'test-story',
      projectRoot: '/test/project'
    });

    const testingIssue = result.issues?.find(i => i.check === 'missing_testing_requirements');
    expect(testingIssue).toBeDefined();
    expect(testingIssue.message).toContain('Testing Requirements');
  });

  it('returns error in structured response, not console.log', async () => {
    fs.existsSync.mockImplementation((p) => {
      if (p.includes('test-story.md')) return true;
      if (p.includes('example.js')) return true;
      return false;
    });
    fs.readFileSync.mockReturnValue(mockStoryWithoutTestingSection);

    const { runPlanReadyTool } = await import('./plan-ready.mjs');
    const result = await runPlanReadyTool({
      projectId: 'test',
      problemId: 'test-story',
      projectRoot: '/test/project'
    });

    // Verify it's in issues array (structured), not console.log
    expect(result.issues).toBeInstanceOf(Array);
    expect(result.ready).toBe(false);
  });
});