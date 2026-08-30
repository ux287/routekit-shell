import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p) => readFileSync(resolve(REPO_ROOT, p), 'utf8');

// Whole-line comparison helper. Never slices a fixed-size window of source.
const hasLine = (src, line) =>
  src.split('\n').some((l) => l.trim() === line.trim());

describe('licensing docs are synced to the AGPL-3.0 dual-licence posture', () => {
  describe('README.md', () => {
    it('contains zero occurrences of MIT and states the dual-licence posture', () => {
      const readme = read('README.md');
      expect(readme).not.toMatch(/\bMIT\b/);
      expect(readme).toMatch(/AGPL-3\.0-or-later/);
      expect(readme).toContain('A separate commercial licence is available');
    });

    it('leaves the RKS Pro section intact', () => {
      const readme = read('README.md');
      for (const phrase of [
        '## RKS Pro',
        'Multi-developer coordination with centralized orchestration',
        'Hosted knowledge graph with multi-project embeddings',
        'Git traffic cop for concurrent AI agents',
        'Enterprise deployment (self-hosted or managed)',
        'RKS Pro inverts the architecture',
        'https://ux287.com/routekit',
      ]) {
        expect(readme).toContain(phrase);
      }
    });

    it('keeps the headings pinned by readme-public-launch-content.test.mjs', () => {
      const readme = read('README.md');
      expect(readme).toMatch(/^##\s+License\b/m);
      expect(readme).toMatch(/^##\s+Learn More\b/m);
    });

    it('requires a signed CLA before merge and says why', () => {
      const readme = read('README.md');
      expect(readme).toContain('A signed [Contributor License Agreement](CLA.md) is required before any contribution is accepted');
      expect(readme).toMatch(/dual-licensed/);
      expect(readme).toMatch(/relicensable/);
    });

    it('routes outside contributors to CONTRIBUTING.md and links CLA.md', () => {
      const readme = read('README.md');
      expect(readme).toContain('[CONTRIBUTING.md](CONTRIBUTING.md)');
      expect(readme).toContain('(CLA.md)');
      expect(readme).toContain('Outside contributors:');
      // The internal loop may still cite CLAUDE.md, but it must be marked as NOT the outside path.
      expect(readme).toContain('it is not the contribution path for outside contributors');
    });

    it('references NOTICE for copyright and third-party attribution', () => {
      expect(read('README.md')).toMatch(/NOTICE/);
    });
  });

  describe('CLA.md', () => {
    it('replaced CONTRIBUTOR-LICENSE.md at the repo root', () => {
      expect(existsSync(resolve(REPO_ROOT, 'CLA.md'))).toBe(true);
      expect(existsSync(resolve(REPO_ROOT, 'CONTRIBUTOR-LICENSE.md'))).toBe(false);
    });

    it('preserves the original grant text verbatim, as whole lines', () => {
      const cla = read('CLA.md');
      for (const line of [
        'You hereby grant to the Maintainer a perpetual, worldwide, non-exclusive, royalty-free, irrevocable license to:',
        '- grant to third parties sublicenses of the foregoing rights under any license, including commercial licenses, as the Maintainer sees fit.',
        '1. You have the legal right to grant the licenses described in this CLA.',
        'The entity grants the same rights as described in Section 2 (Individual Contributor) above.',
      ]) {
        expect(hasLine(cla, line)).toBe(true);
      }
      expect(cla).toContain("This CLA explicitly preserves the Maintainer's right to offer contributions");
      expect(cla).toContain('This grant does not transfer copyright ownership. You retain all rights not expressly granted here.');
    });

    it('defines Project by the software, not by a repo name the reader cannot see', () => {
      const cla = read('CLA.md');
      // A contributor reads this in the public mirror; the private repo name is
      // invisible to them and must not be the operative definition.
      expect(cla).not.toContain('routekit-shell-core');
      expect(cla).toContain('https://github.com/ux287/routekit-shell');
      expect(cla).toMatch(/\*\*"Project"\*\* means RouteKit Shell/);
    });

    it('APPENDS Patent License as section 7 and renumbers nothing', () => {
      const cla = read('CLA.md');
      for (const heading of [
        '## 1. Definitions',
        '## 2. Individual Contributor',
        '## 3. Corporate Contributor',
        '## 4. Commercial Redistribution Rights',
        '## 5. No Warranty',
        '## 6. Governing Law',
        '## 7. Patent License',
        '## 8. Execution',
      ]) {
        expect(cla).toContain(heading);
      }
      expect(cla).not.toContain('## 3. Patent License');
    });

    it('closes with the acknowledgement, relocated to the end after section 8', () => {
      const cla = read('CLA.md');
      const ACK =
        'By submitting a Contribution to this project, you acknowledge that you have read this CLA and agree to its terms.';
      // Exactly one occurrence — the move must not have duplicated it.
      expect(cla.split(ACK)).toHaveLength(2);
      // It closes the document rather than sitting stranded between 6 and 7.
      expect(cla.indexOf(ACK)).toBeGreaterThan(cla.indexOf('## 8. Execution'));
      const lines = cla.split('\n').filter((l) => l.trim() !== '');
      expect(lines[lines.length - 1].trim()).toBe(ACK);
    });

    it('grants a patent licence covering the Work, with defensive termination', () => {
      const cla = read('CLA.md');
      const patent = cla.slice(cla.indexOf('## 7. Patent License'));
      for (const term of ['perpetual', 'worldwide', 'non-exclusive', 'royalty-free', 'irrevocable']) {
        expect(patent).toContain(term);
      }
      expect(patent).toMatch(/and the Work/);
      expect(patent).toContain('Defensive termination');
      expect(patent).toMatch(/patent litigation/);
      expect(patent).toMatch(/terminate as of the date such litigation is filed/);
    });

    it('carries an execution block with name, handle, email and date fields', () => {
      const execution = read('CLA.md').slice(read('CLA.md').indexOf('## 8. Execution'));
      for (const field of ['Full name:', 'GitHub handle:', 'Email:', 'Date:', 'Signature:']) {
        expect(execution).toContain(field);
      }
    });

    it('carries corporate entity fields and a grant-scope election', () => {
      const cla = read('CLA.md');
      const corporate = cla.slice(cla.indexOf('## 3. Corporate Contributor'), cla.indexOf('## 4. Commercial Redistribution Rights'));
      for (const field of [
        'Entity legal name:',
        'Entity address:',
        'Authorized signatory name:',
        'Authorized signatory title:',
      ]) {
        expect(corporate).toContain(field);
      }
      expect(corporate).toMatch(/all\*\* Contributions submitted from any account/);
      expect(corporate).toMatch(/Designated employee schedule/);
      expect(corporate).toContain('Section 7 (Patent License)');
    });
  });

  describe('legal-review posture', () => {
    it('neither CLA.md nor CONTRIBUTING.md claims to be legally reviewed', () => {
      const cla = read('CLA.md');
      expect(cla).toMatch(/not been reviewed by a lawyer/);
      expect(cla).toMatch(/drafted for review by counsel/);
      expect(cla).toMatch(/[Nn]ot legal advice/);

      const contributing = read('CONTRIBUTING.md');
      expect(contributing).toMatch(/has not been reviewed by a lawyer/);
      expect(contributing).toMatch(/drafted for review by counsel/);
      expect(contributing).toMatch(/[Nn]othing in this repository is legal advice/);
    });
  });

  describe('CONTRIBUTING.md', () => {
    it('documents the fork -> branch -> pull request path', () => {
      const c = read('CONTRIBUTING.md');
      expect(c).toMatch(/\*\*Fork\*\*/);
      expect(c).toMatch(/\*\*Branch\*\*/);
      expect(c).toMatch(/\*\*Open a pull request\*\*/);
    });

    it('states the CLA requirement, its dual-licence rationale, and a manual fallback', () => {
      const c = read('CONTRIBUTING.md');
      expect(c).toContain('CLA.md');
      expect(c).toMatch(/before any contribution is accepted/);
      expect(c).toMatch(/dual-licensed/);
      expect(c).toMatch(/relicense every line/);
      expect(c).toMatch(/manual fallback/);
      expect(c).toMatch(/does \*\*not\*\* transfer your copyright/);
    });

    it('explains that PRs are adopted upstream, not merged on the mirror', () => {
      const c = read('CONTRIBUTING.md');
      expect(c).toMatch(/published mirror/);
      expect(c).toMatch(/cannot be merged here/);
      expect(c).toMatch(/closed rather than merged/);
      expect(c).toMatch(/not a rejection/);
      // Attribution must be pointed somewhere that survives a snapshot commit.
      expect(c).toMatch(/credited in \[NOTICE\]\(NOTICE\)/);
      expect(read('NOTICE')).toMatch(/CONTRIBUTORS/);
    });

    it('states the internal dogfood loop is NOT the outside-contributor path', () => {
      const c = read('CONTRIBUTING.md');
      expect(c).toMatch(/internal dogfood loop/);
      expect(c).toMatch(/\*\*not\*\* a contribution path for outside contributors/);
    });
  });

  describe('NOTICE and LICENSE', () => {
    it('NOTICE carries the project copyright and records why it is not in LICENSE', () => {
      const notice = read('NOTICE');
      expect(notice).toMatch(/Copyright[^\n]*\d{4}/);
      expect(notice).toContain('CLA.md');
      expect(notice).toMatch(/appendix template/);
      expect(notice).toMatch(/LICENSE is the unmodified FSF text/);
      expect(notice).toMatch(/THIRD-PARTY SOFTWARE/);
    });

    it('LICENSE is unmodified FSF text with no project-specific copyright', () => {
      const license = read('LICENSE');
      expect(license).toContain('GNU AFFERO GENERAL PUBLIC LICENSE');
      expect(license).toContain('Version 3');
      expect(license).not.toMatch(/RouteKit|UX287|routekit-shell/i);
    });
  });

  describe('offRail.roots final state', () => {
    it('reached 30 entries with the three new names and without the rename source', () => {
      const roots = JSON.parse(read('.rks/project.json')).offRail.roots;
      expect(roots).toHaveLength(30);
      expect(roots).toContain('CLA.md');
      expect(roots).toContain('CONTRIBUTING.md');
      expect(roots).toContain('NOTICE');
      expect(roots).not.toContain('CONTRIBUTOR-LICENSE.md');
    });
  });

  describe('.github enforcement scaffolding', () => {
    it('the PR template carries an unchecked CLA acknowledgement box', () => {
      expect(read('.github/PULL_REQUEST_TEMPLATE.md')).toMatch(/^\s*- \[ \].*CLA/im);
    });

    it('the CLA workflow parses as YAML and triggers on PR and comment events', () => {
      const src = read('.github/workflows/cla-assistant.yml');
      const doc = yaml.load(src);
      // YAML 1.1 readers fold the `on:` key to boolean true; accept either.
      const triggers = doc.on ?? doc[true];
      expect(Object.keys(triggers)).toEqual(expect.arrayContaining(['pull_request_target', 'issue_comment']));
    });

    it('stores signatures in a separate private repo, never inside this repo', () => {
      const src = read('.github/workflows/cla-assistant.yml');
      expect(src).toMatch(/remote-organization-name:/);
      expect(src).toMatch(/remote-repository-name:/);
      // No signature store may resolve inside this repository, or names and
      // emails would be force-pushed to the public mirror.
      expect(existsSync(resolve(REPO_ROOT, 'signatures'))).toBe(false);
    });
  });

  describe('.routekit/publish-profiles.yaml is read-only to this story', () => {
    it('still ships .github/workflows/** and declares a boolean enabled flag for rks-public', () => {
      const src = read('.routekit/publish-profiles.yaml');
      expect(src).toContain('".github/workflows/**"');
      const doc = yaml.load(src);
      // Deliberately NOT pinned to false. Arming the mirror is a legitimate
      // operational act; pinning the disarmed state turned a transient posture into
      // a permanent invariant and reddened CI the moment the mirror was armed.
      // What must hold is that the flag is a LITERAL BOOLEAN - publish.mjs blocks
      // on any other value rather than coercing it, so a string "true" is unsafe.
      expect(typeof doc.remotes['rks-public'].enabled).toBe('boolean');
    });
  });

  describe('no functional CONTRIBUTOR-LICENSE.md reference survives', () => {
    const EXEMPT_PATH = '.routekit/publish-profiles.yaml';
    const SELF = 'tests/unit/licensing-docs-agpl-sync.test.mjs';
    const NEEDLE = 'CONTRIBUTOR-LICENSE';

    const tracked = () => {
      const r = spawnSync('git', ['ls-files'], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        timeout: 30000,
      });
      expect(r.error).toBeUndefined();
      expect(r.status).toBe(0);
      return r.stdout.split('\n').filter(Boolean);
    };

    const hits = (files, needle) => {
      const out = [];
      for (const f of files) {
        let src;
        try {
          src = readFileSync(resolve(REPO_ROOT, f), 'utf8');
        } catch {
          continue; // unreadable or binary — no committed binaries in this repo
        }
        src.split('\n').forEach((text, i) => {
          if (text.includes(needle)) out.push({ file: f, line: i + 1, text });
        });
      }
      return out;
    };

    it('leaves exactly one surviving reference, and it is comment-only', () => {
      const files = tracked().filter((f) => !f.startsWith('notes/') && f !== SELF);
      const found = hits(files, NEEDLE);

      // Positive control: the search machinery finds a string that IS present.
      expect(hits(files, 'AGPL').length).toBeGreaterThan(0);

      expect(found).toHaveLength(1);
      expect(found[0].file).toBe(EXEMPT_PATH);
      // Comment-shaped: first non-whitespace character must be a hash.
      expect(found[0].text.trimStart().startsWith('#')).toBe(true);
    });

    it('every named scope returns zero, each backed by a positive control', () => {
      const files = tracked().filter((f) => f !== SELF);
      const scopes = [
        ['tests/', (f) => f.startsWith('tests/'), 'describe('],
        ['packages/', (f) => f.startsWith('packages/'), 'export'],
        ['scripts/', (f) => f.startsWith('scripts/'), 'const'],
        ['.claude/', (f) => f.startsWith('.claude/'), 'rks'],
        ['.rks/prompts/', (f) => f.startsWith('.rks/prompts/'), 'Governor'],
        ['CLAUDE.md', (f) => f === 'CLAUDE.md', 'Dispatcher'],
        ['README.md', (f) => f === 'README.md', 'rks'],
        // Named as a direct file path: a directory-scoped walk prunes .rks by basename.
        ['.rks/project.json', (f) => f === '.rks/project.json', 'offRail'],
      ];

      for (const [label, pred, control] of scopes) {
        const scoped = files.filter(pred);
        expect(scoped.length, `${label}: scope must be non-empty`).toBeGreaterThan(0);
        expect(hits(scoped, control).length, `${label}: positive control`).toBeGreaterThan(0);
        expect(hits(scoped, NEEDLE), `${label}: must be free of ${NEEDLE}`).toEqual([]);
      }
    });
  });
});
