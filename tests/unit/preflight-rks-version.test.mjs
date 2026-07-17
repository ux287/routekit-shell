/**
 * Witness for the rks version preflight reports.
 *
 * backlog.fix.clean-machine-honesty: this file used to be a pure SOURCE-TEXT MIRROR — it read
 * server.mjs, sliced out the `rks_preflight` handler, and asserted the slice contained the literal
 * string `readRksVersion()`. That asserted nothing about behavior, and it was green the entire time
 * the version field was LYING: preflight reported the version on DISK next to a checks array produced
 * by whatever code Node had loaded at startup. On a real clean machine it announced 0.27.2 while
 * `core_skills` — a check that only exists in 0.27.2 — was absent from the list. A grep for a function
 * name cannot see that; only driving the functions can.
 *
 * (The two behavioral tests below were `describe.skip`'d as "slow dynamic import". They are the ones
 * that were worth keeping. They now run, with the timeout the import actually needs — the same one
 * preflight.test.mjs already uses successfully.)
 *
 * The handler's own wiring in server.mjs is NOT unit-drivable (unit-tier-purity Rule B bans
 * re-importing a >1000-SLOC module), so it is a build-time review obligation, not a grep.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  readRksVersion,
  readDiskRksVersion,
  LOADED_RKS_VERSION,
} from '../../packages/mcp-rks/src/server/preflight.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

describe('the rks version preflight reports', () => {
  it('LOADED_RKS_VERSION is a real version string', () => {
    expect(LOADED_RKS_VERSION).not.toBeNull();
    expect(typeof LOADED_RKS_VERSION).toBe('string');
    expect(LOADED_RKS_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('matches the root package.json version', () => {
    const rootPkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    expect(LOADED_RKS_VERSION).toBe(rootPkg.version);
  });

  it('readRksVersion() reports the LOADED version — the code that is actually running', () => {
    // This is the whole fix. It used to re-read package.json on every call, so it reported whatever
    // was on disk — which after a `git checkout <newtag>` without an MCP-server restart is a
    // DIFFERENT BUILD from the one answering the question.
    expect(readRksVersion()).toBe(LOADED_RKS_VERSION);
  });

  it('readDiskRksVersion() is the separate, honest disk read', () => {
    const rootPkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    expect(readDiskRksVersion()).toBe(rootPkg.version);
  });

  it('on a healthy checkout the two agree (and server_freshness passes)', () => {
    // They diverge only when the server is stale. That case is witnessed in
    // preflight-core-skills.test.mjs, which drives checkGitReadiness with an explicit override —
    // divergence cannot be constructed here, because both of these read the same file.
    expect(LOADED_RKS_VERSION).toBe(readDiskRksVersion());
  });
});
