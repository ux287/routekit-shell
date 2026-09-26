import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadAgentPrompt } from '../../packages/mcp-rks/src/agents/config.mjs';

function makeTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'load-agent-prompt-'));
}

function writeFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

describe('loadAgentPrompt — canonical path (.rks/prompts/)', () => {
  let tmpDir;

  beforeEach(() => { tmpDir = makeTmp(); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it('returns body from .rks/prompts/agent-{name}.md when file exists', () => {
    writeFile(
      path.join(tmpDir, '.rks', 'prompts', 'agent-research.md'),
      'You are the Research Agent.\n\nDo research.'
    );
    const result = loadAgentPrompt('research', tmpDir);
    expect(result).toBe('You are the Research Agent.\n\nDo research.');
  });

  it('strips YAML frontmatter when loading from canonical path', () => {
    writeFile(
      path.join(tmpDir, '.rks', 'prompts', 'agent-git.md'),
      '---\nid: agent-git\ntitle: Git Agent\n---\nYou are the Git Agent.'
    );
    const result = loadAgentPrompt('git', tmpDir);
    expect(result).toBe('You are the Git Agent.');
    expect(result).not.toMatch(/^---/);
  });

  it('returns null when body is empty after frontmatter strip', () => {
    writeFile(
      path.join(tmpDir, '.rks', 'prompts', 'agent-empty.md'),
      '---\nid: agent-empty\n---\n'
    );
    expect(loadAgentPrompt('empty', tmpDir)).toBeNull();
  });
});

describe('loadAgentPrompt — legacy path not consulted', () => {
  let tmpDir;

  beforeEach(() => { tmpDir = makeTmp(); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it('returns null when only notes/public.agents.{name}.prompt.md exists (no fallback)', () => {
    writeFile(
      path.join(tmpDir, 'notes', 'public.agents.dendron.prompt.md'),
      'You are the Dendron Agent.'
    );
    expect(loadAgentPrompt('dendron', tmpDir)).toBeNull();
  });

  it('reads canonical path even when legacy file also exists', () => {
    writeFile(
      path.join(tmpDir, '.rks', 'prompts', 'agent-dendron.md'),
      'Canonical prompt.'
    );
    writeFile(
      path.join(tmpDir, 'notes', 'public.agents.dendron.prompt.md'),
      'Legacy prompt.'
    );
    expect(loadAgentPrompt('dendron', tmpDir)).toBe('Canonical prompt.');
  });
});

describe('loadAgentPrompt — null cases', () => {
  let tmpDir;

  beforeEach(() => { tmpDir = makeTmp(); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it('returns null when neither canonical nor legacy path exists', () => {
    expect(loadAgentPrompt('nonexistent', tmpDir)).toBeNull();
  });

  it('function signature (agentName, projectRoot) remains unchanged', () => {
    expect(typeof loadAgentPrompt).toBe('function');
    expect(loadAgentPrompt.length).toBe(2);
  });
});

const PROJECT_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const ALL_AGENT_NAMES = [
  'research', 'git', 'ship', 'story', 'delivery',
  'recovery', 'cycle-complete', 'telemetry', 'product-owner', 'dendron',
];

describe('loadAgentPrompt — all canonical agent prompts present in project', () => {
  for (const name of ALL_AGENT_NAMES) {
    it(`loadAgentPrompt('${name}') returns non-null from .rks/prompts/`, () => {
      const result = loadAgentPrompt(name, PROJECT_ROOT);
      expect(result).not.toBeNull();
      expect(result.length).toBeGreaterThan(0);
    });
  }

  it('agent-governor.md does NOT exist (governor prompts use governor-*.md pattern)', () => {
    expect(fs.existsSync(path.join(PROJECT_ROOT, '.rks', 'prompts', 'agent-governor.md'))).toBe(false);
  });
});
