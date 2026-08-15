import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';

const TEST_DIR = path.join(process.cwd(), '.tmp-test-exec-abort');
const RUNS_DIR = path.join(TEST_DIR, '.rks', 'runs');

describe('exec_abort run folder detection', () => {
  beforeEach(() => {
    fs.mkdirSync(RUNS_DIR, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('finds incomplete runs in run folders', () => {
    // Create a run folder with incomplete state
    const runDir = path.join(RUNS_DIR, '2026-02-09T12-00-00-000Z_test-run');
    fs.mkdirSync(runDir, { recursive: true });

    const execState = {
      runId: '2026-02-09T12-00-00-000Z_test-run',
      storyId: 'backlog.test',
      currentPhase: 'applyingSteps',
      stepIndex: 0,
      totalSteps: 3,
      completedSteps: [],
      canResume: false
    };
    fs.writeFileSync(path.join(runDir, 'exec-state.json'), JSON.stringify(execState));

    // Verify the file exists
    expect(fs.existsSync(path.join(runDir, 'exec-state.json'))).toBe(true);

    // Parse and verify state
    const parsed = JSON.parse(fs.readFileSync(path.join(runDir, 'exec-state.json'), 'utf8'));
    expect(parsed.currentPhase).toBe('applyingSteps');
    expect(parsed.currentPhase).not.toBe('completed');
  });

  it('ignores completed runs', () => {
    const runDir = path.join(RUNS_DIR, '2026-02-09T12-00-00-000Z_complete-run');
    fs.mkdirSync(runDir, { recursive: true });

    const execState = {
      runId: '2026-02-09T12-00-00-000Z_complete-run',
      currentPhase: 'completed'
    };
    fs.writeFileSync(path.join(runDir, 'exec-state.json'), JSON.stringify(execState));

    const parsed = JSON.parse(fs.readFileSync(path.join(runDir, 'exec-state.json'), 'utf8'));
    expect(parsed.currentPhase).toBe('completed');
  });

  it('handles multiple run folders and returns most recent incomplete', () => {
    // Create older complete run
    const oldRunDir = path.join(RUNS_DIR, '2026-02-09T10-00-00-000Z_old-run');
    fs.mkdirSync(oldRunDir, { recursive: true });
    fs.writeFileSync(path.join(oldRunDir, 'exec-state.json'), JSON.stringify({
      runId: '2026-02-09T10-00-00-000Z_old-run',
      currentPhase: 'completed'
    }));

    // Create newer incomplete run
    const newRunDir = path.join(RUNS_DIR, '2026-02-09T12-00-00-000Z_new-run');
    fs.mkdirSync(newRunDir, { recursive: true });
    fs.writeFileSync(path.join(newRunDir, 'exec-state.json'), JSON.stringify({
      runId: '2026-02-09T12-00-00-000Z_new-run',
      currentPhase: 'applyingSteps',
      storyId: 'backlog.test'
    }));

    // Verify both exist
    const runFolders = fs.readdirSync(RUNS_DIR).sort();
    expect(runFolders.length).toBe(2);

    // The newer run should be incomplete
    const newerState = JSON.parse(fs.readFileSync(path.join(newRunDir, 'exec-state.json'), 'utf8'));
    expect(newerState.currentPhase).toBe('applyingSteps');
  });
});
