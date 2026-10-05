/**
 * Static-analysis tests for the public-launch README.md.
 * (backlog.feat.readme-public-launch-update)
 *
 * Verifies the rewrite contains the required sections and removes the stale
 * pre-launch framing. Doc-shaped — regex matches against the file content,
 * no fixtures, no runtime helpers.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const readmeSrc = fs.readFileSync(path.resolve('README.md'), 'utf8');

describe('README public-launch sections', () => {
  it('has TL;DR section', () => {
    expect(readmeSrc).toMatch(/^##\s+TL;?DR\b/m);
  });

  it('has Who It\'s For section', () => {
    expect(readmeSrc).toMatch(/^##\s+Who It['’]s For\b/m);
  });

  it('has The Problem section', () => {
    expect(readmeSrc).toMatch(/^##\s+The Problem\b/m);
  });

  it('has What "Opinionated" Means in Practice section', () => {
    expect(readmeSrc).toMatch(/^##\s+What ['"]?Opinionated['"]? Means in Practice\b/m);
  });

  it('has Quick Start section', () => {
    expect(readmeSrc).toMatch(/^##\s+Quick Start\b/m);
  });

  it('has The Permission Model section', () => {
    expect(readmeSrc).toMatch(/^##\s+The Permission Model\b/m);
  });

  it('has Architecture at a Glance section', () => {
    expect(readmeSrc).toMatch(/^##\s+Architecture at a Glance\b/m);
  });

  it('has Cost & Efficiency Visibility section', () => {
    expect(readmeSrc).toMatch(/^##\s+Cost (?:&|and) Efficiency\b/m);
  });

  it('has Honest Limitations section', () => {
    expect(readmeSrc).toMatch(/^##\s+Honest Limitations\b/m);
  });

  it('has Status & Maturity section', () => {
    expect(readmeSrc).toMatch(/^##\s+Status (?:&|and) Maturity\b/m);
  });

  it('has Learn More section', () => {
    expect(readmeSrc).toMatch(/^##\s+Learn More\b/m);
  });

  it('has License section', () => {
    expect(readmeSrc).toMatch(/^##\s+License\b/m);
  });
});

describe('README public-launch content requirements', () => {
  it('removes the outdated "toggle guardrails off for exploration" framing', () => {
    expect(readmeSrc).not.toMatch(/toggle guardrails off for exploration/i);
  });

  it('mentions the build-only permission tier', () => {
    expect(readmeSrc).toMatch(/\bbuild-only\b/);
  });

  it('mentions the framework-update permission tier', () => {
    expect(readmeSrc).toMatch(/\bframework-update\b/);
  });

  // The README links to the PUBLIC deep-dive blog series (ux287.com/thinking), not the
  // internal research papers — those live in notes/research.* and don't ship in the
  // rks-public snapshot, so linking them would 404 for a cloner. See the .routekit
  // publish allowlist (research.public.** only).
  it('links to the Current Architecture deep-dive', () => {
    expect(readmeSrc).toMatch(/thinking\/2026\.06\.30\.rks-current-architecture/);
  });

  it('links to the Workflow deep-dive', () => {
    expect(readmeSrc).toMatch(/thinking\/2026\.01\.22\.rks-workflow-deep-dive/);
  });

  it('links to the Agentified Workflow deep-dive', () => {
    expect(readmeSrc).toMatch(/thinking\/2026\.02\.21\.rks-agentified-workflow-deep-dive/);
  });

  it('references the guided onboarding entry point', () => {
    expect(readmeSrc).toMatch(/\/rks-onboard\b|rks_onboarder|rks_interview/);
  });

  it('includes a Work with UX287 callout', () => {
    expect(readmeSrc).toMatch(/Work with UX287/i);
    expect(readmeSrc).toMatch(/ux287\.com/i);
  });

  it('Quick Start references Claude Code as the entry point', () => {
    const quickStartMatch = readmeSrc.match(/^##\s+Quick Start[\s\S]*?(?=^##\s+|\Z)/m);
    expect(quickStartMatch).toBeTruthy();
    expect(quickStartMatch[0]).toMatch(/Claude Code/);
  });

  it('Quick Start documents the npm install → npm run setup one-command flow', () => {
    const quickStartMatch = readmeSrc.match(/^##\s+Quick Start[\s\S]*?(?=^##\s+|\Z)/m);
    expect(quickStartMatch).toBeTruthy();
    expect(quickStartMatch[0]).toMatch(/npm install/);
    expect(quickStartMatch[0]).toMatch(/npm run setup/);
  });

  it('Quick Start does not instruct users to paste raw MCP tool JSON', () => {
    // Pre-launch README had blocks like: dendron_create_note { "vault": "notes", "fname": "..." }
    // Public-launch should route through slash commands, not raw MCP-call JSON.
    const quickStartMatch = readmeSrc.match(/^##\s+Quick Start[\s\S]*?(?=^##\s+|\Z)/m);
    expect(quickStartMatch).toBeTruthy();
    // No raw {"vault": ...} or {"projectId": ...} JSON blocks in Quick Start
    expect(quickStartMatch[0]).not.toMatch(/dendron_create_note\s*\{/);
    expect(quickStartMatch[0]).not.toMatch(/rks_plan\s*\{[^}]*projectId/);
  });
});
