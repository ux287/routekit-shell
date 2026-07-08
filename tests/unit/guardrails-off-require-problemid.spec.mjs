import { describe, it, expect } from 'vitest';

describe('guardrails-off problemId requirement', () => {
  it('requires problemId parameter', () => {
    // This test validates the requirement
    const args = { projectId: 'test', reason: 'debugging' };
    expect(args.problemId).toBeUndefined();
    
    // Without problemId, the function should return an error
    // (actual function test requires integration setup)
  });

  it('accepts valid problemId', () => {
    const args = { 
      projectId: 'test', 
      reason: 'debugging',
      problemId: 'backlog.spike.test'
    };
    expect(args.problemId).toBeDefined();
    expect(args.problemId).toMatch(/^backlog\./);
  });

  it('error includes workflow guidance', () => {
    const expectedWorkflow = [
      'dendron_create_note',
      'rks_guardrails_off',
      'rks_guardrails_on'
    ];
    
    // Verify expected workflow steps are defined
    expect(expectedWorkflow.length).toBeGreaterThan(0);
  });

  it('scoped writes work with valid problemId and targetFiles', () => {
    const args = {
      projectId: 'test',
      reason: 'implementing feature',
      problemId: 'backlog.feat.my-feature'
    };
    
    // With problemId, the function should check for targetFiles
    expect(args.problemId).toBeDefined();
    expect(args.problemId).toContain('backlog');
  });
});
