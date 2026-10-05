import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { classifySource, SOURCE_CLASSES } from '@routekit/rag/source-classifier';

describe('classifySource', () => {
  describe('frontmatter override', () => {
    it('uses explicit source_class from frontmatter', () => {
      const result = classifySource({
        path: 'notes/public-doc.md',
        frontmatter: { source_class: 'sensitive' },
        content: 'Normal content',
        domain: 'notes'
      });
      expect(result).toBe(SOURCE_CLASSES.SENSITIVE);
    });

    it('ignores invalid frontmatter values', () => {
      const result = classifySource({
        path: 'notes/doc.md',
        frontmatter: { source_class: 'invalid-class' },
        content: 'Normal content',
        domain: 'notes'
      });
      expect(result).toBe(SOURCE_CLASSES.PROJECT);
    });

    it('handles missing frontmatter gracefully', () => {
      const result = classifySource({
        path: 'notes/doc.md',
        content: 'Normal content'
      });
      expect(result).toBe(SOURCE_CLASSES.PROJECT);
    });

    it('handles undefined options gracefully', () => {
      const result = classifySource();
      expect(result).toBe(SOURCE_CLASSES.PROJECT);
    });
  });

  describe('path pattern matching', () => {
    it('classifies clients/ paths as client', () => {
      expect(classifySource({ path: 'clients/acme/notes.md' })).toBe(SOURCE_CLASSES.CLIENT);
    });

    it('classifies client. prefix as client', () => {
      expect(classifySource({ path: 'client.acme.notes.md' })).toBe(SOURCE_CLASSES.CLIENT);
    });

    it('classifies secrets/ paths as sensitive', () => {
      expect(classifySource({ path: 'secrets/api-keys.md' })).toBe(SOURCE_CLASSES.SENSITIVE);
    });

    it('classifies .env files as sensitive', () => {
      expect(classifySource({ path: '.env' })).toBe(SOURCE_CLASSES.SENSITIVE);
      expect(classifySource({ path: '.env.local' })).toBe(SOURCE_CLASSES.SENSITIVE);
    });

    it('classifies credentials paths as sensitive', () => {
      expect(classifySource({ path: 'credentials/aws.json' })).toBe(SOURCE_CLASSES.SENSITIVE);
    });

    it('classifies legal/ paths as legal', () => {
      expect(classifySource({ path: 'legal/contract-template.md' })).toBe(SOURCE_CLASSES.LEGAL);
    });

    it('classifies compliance/ paths as legal', () => {
      expect(classifySource({ path: 'compliance/gdpr.md' })).toBe(SOURCE_CLASSES.LEGAL);
    });

    it('classifies contracts/ paths as legal', () => {
      expect(classifySource({ path: 'contracts/nda.md' })).toBe(SOURCE_CLASSES.LEGAL);
    });

    it('classifies vendor/ paths as public', () => {
      expect(classifySource({ path: 'vendor/lodash/readme.md' })).toBe(SOURCE_CLASSES.PUBLIC);
    });

    it('classifies third-party paths as public', () => {
      expect(classifySource({ path: 'third-party/react/index.js' })).toBe(SOURCE_CLASSES.PUBLIC);
    });

    it('classifies incident/ paths as sensitive', () => {
      expect(classifySource({ path: 'incident/2024-01-breach.md' })).toBe(SOURCE_CLASSES.SENSITIVE);
    });

    it('classifies postmortem/ paths as sensitive', () => {
      expect(classifySource({ path: 'postmortem/outage-report.md' })).toBe(SOURCE_CLASSES.SENSITIVE);
    });
  });

  describe('path patterns match whole directory segments, not Dendron dot-names (D6)', () => {
    // backlog.fix.source-class-never-projected-fidelity-defaults-permissive D6/D6a. Content is
    // marker-free so the path rule alone decides. Under the old unanchored PATH_PATTERNS most PROJECT
    // cases below were classified legal or sensitive by their filename.
    const cls = (path) => classifySource({ path, content: 'Normal content' });

    it.each([
      ['notes/legal/nda.md', SOURCE_CLASSES.LEGAL],
      ['docs/contracts/msa.md', SOURCE_CLASSES.LEGAL],
      ['docs/contract/msa.md', SOURCE_CLASSES.LEGAL],
      ['org/compliance/soc2.md', SOURCE_CLASSES.LEGAL],
      ['docs/security/threat-model.md', SOURCE_CLASSES.SENSITIVE],
      ['security/threat-model.md', SOURCE_CLASSES.SENSITIVE],
      ['docs/Security/Plan.md', SOURCE_CLASSES.SENSITIVE],
      ['ops/incident/x.md', SOURCE_CLASSES.SENSITIVE],
      ['ops/postmortem/x.md', SOURCE_CLASSES.SENSITIVE],
      ['config/secrets/x.yaml', SOURCE_CLASSES.SENSITIVE],
      ['config/credentials/x.yaml', SOURCE_CLASSES.SENSITIVE],
      ['app/.env', SOURCE_CLASSES.SENSITIVE],
      ['app/.env.production', SOURCE_CLASSES.SENSITIVE],
      ['.env.example', SOURCE_CLASSES.SENSITIVE],
    ])('directory segment or .env filename %s still classifies by path', (path, expected) => {
      expect(cls(path)).toBe(expected);
    });

    it.each([
      'backlog.feat.git-agent-evidence-bound-output-contract.md',
      'backlog.feat.governor-init-resume-vs-reset-contract.md',
      'backlog.feat.rag-module-public-contract.md',
      'backlog.feat.research-agent-exhaustive-search.tool-and-absence-contract.md',
      'backlog.fix.arch-reserved-fields-write-contract.md',
      'backlog.fix.research-agent-output-contract.md',
      'project-business.legal.aar-defense.analysis.md',
      'backlog.security.ci-secret-scan-workflow.md',
      'backlog.security.gitleaks-gate-arming.md',
      'backlog.security.publish-mirror-secret-scan.md',
      'backlog.feat.env-example.md',
      'backlog.z_implemented.feat.env-example.env-example-file.md',
      'backlog.z_implemented.feat.env-example.env-example-cleanup.md',
      'backlog.z_implemented.feat.env-example.env-example-tests.md',
      'backlog.z_implemented.feat.env-example.file-ends-reminder.md',
      'notes/backlog.feat.env-example.md',
      'notes/project-business.legal.aar-defense.analysis.md',
      'security.md',
      'legal.md',
      '.envrc',
    ])('dot-name %s classifies project', (path) => {
      expect(cls(path)).toBe(SOURCE_CLASSES.PROJECT);
    });

    it.each(['config/secrets.json', 'credentials.yaml', 'secrets.env', 'app/secret.yaml', 'credential.txt'])(
      'D6a: final segment named secret(s) or credential(s) (%s) classifies sensitive', (path) => {
        expect(cls(path)).toBe(SOURCE_CLASSES.SENSITIVE);
      });

    it.each(['backlog.feat.rotate-secrets.md', 'backlog.secrets.md', 'notes/my-secrets.json', 'secretsauce.json', 'docs/secrets-policy.md'])(
      'D6a: %s (word is not the whole first dot-segment of the basename) classifies project', (path) => {
        expect(cls(path)).toBe(SOURCE_CLASSES.PROJECT);
      });
  });

  describe('content marker detection', () => {
    it('prose mentioning API_KEY and SECRET is project, not sensitive (D2)', () => {
      const result = classifySource({
        path: 'notes/config.md',
        content: 'The API_KEY is SECRET and should not be shared'
      });
      expect(result).toBe(SOURCE_CLASSES.PROJECT);
    });

    it('prose containing the word PRIVATE is project (D2)', () => {
      const result = classifySource({
        path: 'notes/internal.md',
        content: 'This document is PRIVATE'
      });
      expect(result).toBe(SOURCE_CLASSES.PROJECT);
    });

    it('a CONFIDENTIAL label in prose is project (D2: declare source_class in frontmatter instead)', () => {
      const result = classifySource({
        path: 'notes/report.md',
        content: 'CONFIDENTIAL - For internal use only'
      });
      expect(result).toBe(SOURCE_CLASSES.PROJECT);
    });

    it('prose naming API_KEY without a value is project (D2)', () => {
      const result = classifySource({
        path: 'notes/setup.md',
        content: 'Set your API_KEY in the environment'
      });
      expect(result).toBe(SOURCE_CLASSES.PROJECT);
    });

    it('detects password patterns as sensitive', () => {
      const result = classifySource({
        path: 'notes/setup.md',
        content: 'Database password: hunter2'
      });
      expect(result).toBe(SOURCE_CLASSES.SENSITIVE);
    });

    it('detects password= pattern as sensitive', () => {
      const result = classifySource({
        path: 'notes/config.md',
        content: 'password=mysecretpass'
      });
      expect(result).toBe(SOURCE_CLASSES.SENSITIVE);
    });

    it('only checks first 2000 chars for performance', () => {
      // A credential-shaped value placed after 3000 chars of padding is outside the inspected window.
      const longContent = 'some text '.repeat(300) + ' api_key=' + 'A'.repeat(24) + ' at end';
      const result = classifySource({
        path: 'notes/long-doc.md',
        content: longContent
      });
      expect(result).toBe(SOURCE_CLASSES.PROJECT); // credential is after 2000 chars
    });

    it('detects markers within first 2000 chars', () => {
      // A credential-shaped value at offset ~1000 is inside the inspected window.
      const content = 'some text '.repeat(100) + 'api_key=' + 'A'.repeat(24) + ' more text'.repeat(200);
      const result = classifySource({
        path: 'notes/doc.md',
        content
      });
      expect(result).toBe(SOURCE_CLASSES.SENSITIVE);
    });

    it('prose discussing secrets, private data, confidentiality and API keys together is project (D2)', () => {
      const result = classifySource({
        path: 'notes/design.md',
        content: 'Never commit a secret. Keep private data private, mark CONFIDENTIAL reports, and put the API key in an env var.'
      });
      expect(result).toBe(SOURCE_CLASSES.PROJECT);
    });

    // Every credential-shaped fixture is ASSEMBLED AT RUNTIME (concatenation / repeat) so no literal
    // credential appears in the source: the repo's gitleaks pre-commit hook rejects literal shapes
    // (it blocked the QA write of this very block when the fixtures were literals).
    const v = (n) => 'Ab1'.repeat(Math.ceil(n / 3)).slice(0, n);
    it.each([
      ['an api_key assignment with a 16+ char value', 'api_key = ' + v(24)],
      ['a client_secret assignment', 'client_' + 'secret: ' + v(21)],
      ['a PEM RSA private key header', '-----BEGIN RSA ' + 'PRIVATE KEY-----'],
      ['a bare PEM private key header', '-----BEGIN ' + 'PRIVATE KEY-----'],
      ['an AWS access key id', 'aws id ' + 'AK' + 'IA' + 'Q'.repeat(16) + ' here'],
      ['a GitHub token', 'token gh' + 'p_' + v(36)],
      ['a Slack token', 'xo' + 'xb-' + '1'.repeat(10) + '-' + v(10)],
      ['an Anthropic key', 'key sk-' + 'ant-' + v(24)],
      ['a Bearer credential', 'Authorization: Bearer ' + v(24)],
      ['an SSN-shaped value', 'SSN on file: ' + '123-' + '45-' + '6789'],
    ])('classifies %s as sensitive', (_label, content) => {
      expect(classifySource({ path: 'notes/doc.md', content })).toBe(SOURCE_CLASSES.SENSITIVE);
    });

    it.each([
      ['API_KEY= with no value', 'Set API_KEY= in your shell profile'],
      ['an api_key placeholder', 'api_key: <your-key>'],
      ['a 13-digit epoch number', 'created: 1788012728742'],
      ['an api_key value shorter than 16 chars', 'api_key=abc123'],
      ['Bearer in prose', 'Bearer tokens are sent in the Authorization header'],
      ['a password label with no value', 'Reset your password:'],
    ])('classifies near-miss %s as project', (_label, content) => {
      expect(classifySource({ path: 'notes/doc.md', content })).toBe(SOURCE_CLASSES.PROJECT);
    });

    it('trap witness: the lines of fidelity-filter.mjs that discuss secrets classify as project', () => {
      // fidelity-filter.mjs talks ABOUT secrecy; under the old bare-word markers it self-classified as
      // sensitive. Build the content from its own lines that contain the word, so the 2000-char window
      // cannot hide them.
      const src = readFileSync(new URL('../../packages/rag/src/fidelity-filter.mjs', import.meta.url), 'utf8');
      const content = src.split('\n').filter((l) => /\bsecret\b/i.test(l)).join('\n');
      expect(content).toMatch(/\bsecret\b/i); // positive control: the old SECRET marker would fire here
      expect(content.length).toBeLessThan(2000);
      expect(classifySource({ path: 'packages/rag/src/fidelity-filter.mjs', content })).toBe(SOURCE_CLASSES.PROJECT);
    });
  });

  describe('default classification', () => {
    it('defaults to project for notes domain', () => {
      const result = classifySource({
        path: 'notes/backlog.feature.something.md',
        domain: 'notes'
      });
      expect(result).toBe(SOURCE_CLASSES.PROJECT);
    });

    it('defaults to project for code domain', () => {
      const result = classifySource({
        path: 'packages/cli/src/index.mjs',
        domain: 'code'
      });
      expect(result).toBe(SOURCE_CLASSES.PROJECT);
    });

    it('defaults to project for unknown paths', () => {
      const result = classifySource({
        path: 'random/unknown/file.txt'
      });
      expect(result).toBe(SOURCE_CLASSES.PROJECT);
    });
  });

  describe('priority order', () => {
    it('frontmatter overrides path patterns', () => {
      // Even though path matches 'clients/', frontmatter says public
      const result = classifySource({
        path: 'clients/acme/public-readme.md',
        frontmatter: { source_class: 'public' }
      });
      expect(result).toBe(SOURCE_CLASSES.PUBLIC);
    });

    it('path patterns override content markers', () => {
      // vendor/ path classifies as public even with a credential-shaped value in content
      const content = 'api_key = ' + 'Ab1'.repeat(8); // assembled at runtime (gitleaks)
      const result = classifySource({
        path: 'vendor/lib/config.md',
        content
      });
      expect(result).toBe(SOURCE_CLASSES.PUBLIC);
      // control: the same content at a non-matching path IS sensitive, so the override is real
      expect(classifySource({ path: 'notes/config.md', content })).toBe(SOURCE_CLASSES.SENSITIVE);
    });
  });
});

describe('SOURCE_CLASSES', () => {
  it('exports all expected source classes', () => {
    expect(SOURCE_CLASSES.PUBLIC).toBe('public');
    expect(SOURCE_CLASSES.PROJECT).toBe('project');
    expect(SOURCE_CLASSES.CLIENT).toBe('client');
    expect(SOURCE_CLASSES.SENSITIVE).toBe('sensitive');
    expect(SOURCE_CLASSES.LEGAL).toBe('legal');
  });
});
