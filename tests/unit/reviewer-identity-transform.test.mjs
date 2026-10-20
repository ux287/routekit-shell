/**
 * Unit tests for the identity-transform guard in extractExplicitEdits (Pattern 5).
 *
 * @@SEARCH/@@REPLACE/@@END blocks where search === replace are plan_ready
 * validation markers only — they must NOT become executable plan steps.
 */

import { describe, it, expect } from 'vitest';
import { extractExplicitEdits } from '../../packages/mcp-rks/src/llm/reviewer.mjs';

describe('extractExplicitEdits — identity transform guard (Pattern 5)', () => {
  it('skips a single identity-transform @@SEARCH/@@REPLACE/@@END block', () => {
    const story = `
### components/Foo.tsx

@@SEARCH
export function Foo() {
@@REPLACE
export function Foo() {
@@END
`;
    const edits = extractExplicitEdits(story);
    expect(edits).toHaveLength(0);
  });

  it('keeps a non-identity @@SEARCH/@@REPLACE/@@END block', () => {
    const story = `
### components/Foo.tsx

@@SEARCH
export function Foo() {
  return null;
}
@@REPLACE
export function Foo() {
  return <div />;
}
@@END
`;
    const edits = extractExplicitEdits(story);
    expect(edits).toHaveLength(1);
    expect(edits[0].source).toBe('at_marker_block');
    expect(edits[0].search).toContain('return null');
    expect(edits[0].replace).toContain('return <div />');
  });

  it('filters identity blocks and keeps non-identity blocks from a mixed set', () => {
    const story = `
### components/Foo.tsx

@@SEARCH
export function Foo() {
@@REPLACE
export function Foo() {
@@END

@@SEARCH
const x = 1;
@@REPLACE
const x = 2;
@@END
`;
    const edits = extractExplicitEdits(story);
    expect(edits).toHaveLength(1);
    expect(edits[0].search).toContain('const x = 1');
    expect(edits[0].replace).toContain('const x = 2');
  });

  it('de-dup guard still rejects duplicate non-identity blocks', () => {
    const story = `
### components/Foo.tsx

@@SEARCH
const x = 1;
@@REPLACE
const x = 2;
@@END

@@SEARCH
const x = 1;
@@REPLACE
const x = 3;
@@END
`;
    const edits = extractExplicitEdits(story);
    // Second block has same search — de-dup should reject it
    expect(edits).toHaveLength(1);
    expect(edits[0].replace).toContain('const x = 2');
  });

  it('skips an identity block that includes a File: path prefix', () => {
    const story = `
File: components/Foo.tsx
@@SEARCH
export function Foo() {
@@REPLACE
export function Foo() {
@@END
`;
    const edits = extractExplicitEdits(story);
    expect(edits).toHaveLength(0);
  });

  it('skips multiple identity blocks across different files', () => {
    const story = `
### components/Foo.tsx

@@SEARCH
export function Foo() {
@@REPLACE
export function Foo() {
@@END

### components/Bar.tsx

@@SEARCH
export function Bar() {
@@REPLACE
export function Bar() {
@@END
`;
    const edits = extractExplicitEdits(story);
    expect(edits).toHaveLength(0);
  });
});
