import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const NOTES_DIR = path.join(PROJECT_ROOT, 'notes');
const PROMPTS_DIR = path.join(PROJECT_ROOT, '.rks', 'prompts');

const EXPECTED_AGENT_PROMPTS = [
  'agent-research.md',
  'agent-git.md',
  'agent-ship.md',
  'agent-story.md',
  'agent-delivery.md',
  'agent-recovery.md',
  'agent-cycle-complete.md',
  'agent-telemetry.md',
  'agent-product-owner.md',
  'agent-dendron.md',
];

describe('stale notes/agents.* namespace is gone', () => {
  it('no notes/agents.*.prompt.md files exist', () => {
    const files = fs.readdirSync(NOTES_DIR).filter(f => /^agents\..+\.prompt\.md$/.test(f));
    expect(files).toHaveLength(0);
  });
});

describe('stale notes/public.agents.* namespace is gone', () => {
  it('no notes/public.agents.*.prompt.md files exist', () => {
    const files = fs.readdirSync(NOTES_DIR).filter(f => /^public\.agents\..+\.prompt\.md$/.test(f));
    expect(files).toHaveLength(0);
  });
});

describe('all canonical agent prompts present in .rks/prompts/', () => {
  for (const file of EXPECTED_AGENT_PROMPTS) {
    it(`${file} exists and is non-empty`, () => {
      const filePath = path.join(PROMPTS_DIR, file);
      expect(fs.existsSync(filePath)).toBe(true);
      const content = fs.readFileSync(filePath, 'utf8').trim();
      expect(content.length).toBeGreaterThan(0);
    });
  }
});
