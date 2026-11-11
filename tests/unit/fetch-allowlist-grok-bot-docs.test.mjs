// backlog.feat.fetch-allowlist-grok-bot-docs
// Witnesses the SHELL allowlist (.rks/project.json fetchRaw.allowedHosts) through the
// gate that enforces it: loadAllowedHosts + hostAllowed from fetch-raw.mjs. Presence
// checks only, never exact list equality, so future host additions do not redden it.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadAllowedHosts, hostAllowed } from '../../packages/mcp-rks/src/agents/fetch-raw.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PROJECT_JSON = path.join(REPO_ROOT, '.rks', 'project.json');

const GROK_BOT_HOSTS = ['docs.x.ai', 'cursor.com'];

// Every host listed before this story (anchor @567da1dcd). All must survive.
const PRIOR_HOSTS = [
  'www.ux287.com', 'ux287.com', 'routekit.dev', 'www.routekit.dev',
  'code.claude.com', 'docs.claude.com', 'docs.anthropic.com', 'github.com',
  'docs.github.com', 'api.github.com', 'raw.githubusercontent.com',
  'objects.githubusercontent.com', 'registry.npmjs.org', 'www.npmjs.com',
  'nodejs.org', 'developer.mozilla.org', 'modelcontextprotocol.io',
  'spec.modelcontextprotocol.io', 'arxiv.org', 'blog.langchain.com',
  'developers.openai.com', 'openai.com', 'www.anthropic.com', 'martinfowler.com',
  'code.visualstudio.com', 'www.warp.dev', 'factory.ai', 'vercel.com',
  'openrouter.ai', 'www.databricks.com', 'docs.litellm.ai', 'docs.portkey.ai',
  'learn.chatgpt.com', 'next.redhat.com', 'mem0.ai', 'www.braintrust.dev',
  'stevekinney.com', 'getinstinct.com', 'instinct.ai', 'platform.claude.com',
  'docs.langchain.com', 'reference.langchain.com', 'openai.github.io',
  'docs.granola.ai', 'www.granola.ai', 'docs.dendron.so', 'wiki.dendron.so',
  'mutcd.fhwa.dot.gov',
];

describe('fetch allowlist — Grok Bot primary docs hosts', () => {
  it('.rks/project.json parses as JSON and fetchRaw.mode is still allowlist', () => {
    const cfg = JSON.parse(fs.readFileSync(PROJECT_JSON, 'utf8'));
    expect(cfg.fetchRaw).toBeTruthy();
    expect(cfg.fetchRaw.mode).toBe('allowlist');
    expect(Array.isArray(cfg.fetchRaw.allowedHosts)).toBe(true);
  });

  it('fetchRaw.allowedHosts contains docs.x.ai and cursor.com', () => {
    const hosts = loadAllowedHosts(REPO_ROOT);
    for (const h of GROK_BOT_HOSTS) expect(hosts, `shell allowlist missing ${h}`).toContain(h);
  });

  it('every previously listed host is still present', () => {
    const hosts = loadAllowedHosts(REPO_ROOT);
    for (const h of PRIOR_HOSTS) expect(hosts, `shell allowlist lost ${h}`).toContain(h);
  });

  it('hostAllowed returns true for docs.x.ai and cursor.com against the shell list', () => {
    const shell = loadAllowedHosts(REPO_ROOT);
    for (const h of GROK_BOT_HOSTS) {
      expect(hostAllowed(h, shell), `${h} not matchable against shell list`).toBe(true);
    }
  });

  it('hostAllowed still refuses a host absent from the list (grokbotwiki.com)', () => {
    const shell = loadAllowedHosts(REPO_ROOT);
    expect(shell).not.toContain('grokbotwiki.com');
    expect(hostAllowed('grokbotwiki.com', shell)).toBe(false);
  });
});
