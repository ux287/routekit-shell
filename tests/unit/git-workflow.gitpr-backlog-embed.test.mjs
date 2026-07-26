import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const src = fs.readFileSync(
  path.resolve('packages/mcp-rks/src/server/git/git-workflow.mjs'),
  'utf8'
);

describe('runGitPR backlog-status block uses commitAndEmbed', () => {
  it('calls commitAndEmbed (not bare runGit commit) in the backlog-status block', () => {
    const backlogBlock = src.slice(src.indexOf('backlogResult = updateBacklogStatus'));
    expect(backlogBlock).toContain('commitAndEmbed');
    expect(backlogBlock).not.toMatch(/runGit\(projectRoot,\s*\["commit"/);
  });

  it('commitAndEmbed call is awaited (async-correct)', () => {
    expect(src).toMatch(/await commitAndEmbed\(projectRoot,\s*`docs\(backlog\)/);
  });

  it('ragEmbedWarning is captured from commitAndEmbed result (not silently dropped)', () => {
    expect(src).toMatch(/\{\s*ragEmbedWarning\s*\}\s*=\s*await commitAndEmbed/);
    expect(src).toContain('backlogEmbedWarning');
  });

  it('try/catch is preserved around the commitAndEmbed call (non-fatal)', () => {
    const start = src.indexOf('backlogResult = updateBacklogStatus');
    const backlogBlock = src.slice(start, start + 800);
    expect(backlogBlock).toMatch(/try\s*\{/);
    expect(backlogBlock).toMatch(/catch\s*\(err\)/);
  });

  it('ragEmbedWarning is included in the return value', () => {
    expect(src).toContain('backlogEmbedWarning');
    expect(src).toMatch(/ragEmbedWarning.*backlogEmbedWarning/);
  });

  it('commitAndEmbed import is present in git-workflow.mjs', () => {
    expect(src).toContain('commit-and-embed.mjs');
    expect(src).toContain('commitAndEmbed');
  });
});
