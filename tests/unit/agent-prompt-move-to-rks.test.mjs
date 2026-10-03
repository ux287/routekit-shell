import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadAgentPrompt } from '../../packages/mcp-rks/src/agents/config.mjs';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

describe('agent-dendron prompt migration', () => {
  it('.rks/prompts/agent-dendron.md exists', () => {
    expect(fs.existsSync(path.join(PROJECT_ROOT, '.rks', 'prompts', 'agent-dendron.md'))).toBe(true);
  });

  it('.rks/prompts/agent-dendron.md contains the prompt body with no YAML frontmatter', () => {
    const content = fs.readFileSync(path.join(PROJECT_ROOT, '.rks', 'prompts', 'agent-dendron.md'), 'utf8');
    expect(content).not.toMatch(/^---/);
    expect(content).toContain('You are a Dendron Agent');
  });

  it('notes/public.agents.dendron.prompt.md is deleted', () => {
    expect(fs.existsSync(path.join(PROJECT_ROOT, 'notes', 'public.agents.dendron.prompt.md'))).toBe(false);
  });

  it('notes/agents.dendron.prompt.md is deleted', () => {
    expect(fs.existsSync(path.join(PROJECT_ROOT, 'notes', 'agents.dendron.prompt.md'))).toBe(false);
  });

  it('loadAgentPrompt("dendron") returns the correct prompt body from .rks/prompts/', () => {
    const result = loadAgentPrompt('dendron', PROJECT_ROOT);
    expect(result).toBeTruthy();
    expect(result).toContain('You are a Dendron Agent');
  });

  it('no source files reference notes/public.agents.dendron.prompt.md', () => {
    // Grep packages/ and scripts/ for the old path
    function scanDir(dir, pattern, found = []) {
      if (!fs.existsSync(dir)) return found;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { scanDir(full, pattern, found); continue; }
        if (!entry.name.endsWith('.mjs') && !entry.name.endsWith('.js') && !entry.name.endsWith('.ts')) continue;
        const content = fs.readFileSync(full, 'utf8');
        if (content.includes(pattern)) found.push(full);
      }
      return found;
    }
    const hits = [
      ...scanDir(path.join(PROJECT_ROOT, 'packages'), 'public.agents.dendron'),
      ...scanDir(path.join(PROJECT_ROOT, 'scripts'), 'public.agents.dendron'),
    ];
    expect(hits).toHaveLength(0);
  });
});
