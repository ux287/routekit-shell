/**
 * Unit tests for extractCreateFileBlocks in planner-utils.mjs
 *
 * Specifically targets the boundary-crossing bug where the old regex
 * matched a ### Target: section header then lazily grabbed the FIRST
 * code block found anywhere below it — including source blocks in
 * adjacent ### sections.
 */

import { describe, it, expect } from 'vitest';
import { extractCreateFileBlocks } from '../../packages/mcp-rks/src/server/planner-utils.mjs';

describe('extractCreateFileBlocks — // CREATE FILE: directive boundary crossing', () => {
  it('does NOT extract source block via // CREATE FILE: directive when no adjacent code block', () => {
    // Exact concourse-prototype failure pattern:
    // refine.mjs injects "// CREATE FILE: path" with no code block
    // Source block exists later in the story under a ### heading
    // Old regex scanned across the ### boundary and grabbed the source block
    const md = `
## Files to Create

// CREATE FILE: src/hooks/useDisplayActions.ts

## Code Changes

### Target: src/hooks/useDisplayActions.ts

Function signature: \`export function useDisplayActions(): DisplayActionsHook\`

### displayActions logic (source for extraction):

\`\`\`typescript
// Context: existing implementation for reference
export function useDisplayActions() {
  return { actions: [] };
}
\`\`\`
`;
    const blocks = extractCreateFileBlocks(md);
    // The // CREATE FILE: directive has no adjacent code block.
    // Should NOT have been populated with the source block content.
    expect(blocks.has('src/hooks/useDisplayActions.ts')).toBe(false);
  });

  it('DOES extract code block when // CREATE FILE: directive is immediately followed by a code block', () => {
    const md = `
// CREATE FILE: src/hooks/useDisplayActions.ts

\`\`\`typescript
import { useCallback } from 'react';
export function useDisplayActions() {
  return { dispatch: useCallback(() => {}, []) };
}
\`\`\`
`;
    const blocks = extractCreateFileBlocks(md);
    expect(blocks.has('src/hooks/useDisplayActions.ts')).toBe(true);
    expect(blocks.get('src/hooks/useDisplayActions.ts')).toContain('useCallback');
  });

  it('does NOT cross ### boundary when // CREATE FILE: directive has no adjacent code block — two files', () => {
    const md = `
## Files to Create

// CREATE FILE: src/hooks/useDisplayActions.ts
// CREATE FILE: src/hooks/useActionNumbering.ts

## Code Changes

### Target: src/hooks/useDisplayActions.ts

Signature: \`export function useDisplayActions(): DisplayActionsHook\`

### Source: useDisplayActions (existing)

\`\`\`typescript
// Context: old impl
export function useDisplayActions() { return {}; }
\`\`\`

### Target: src/hooks/useActionNumbering.ts

Signature: \`export function useActionNumbering(actions: Action[]): string[]\`

### Source: useActionNumbering (existing)

\`\`\`typescript
// Context: old numbering
export function useActionNumbering() { return []; }
\`\`\`
`;
    const blocks = extractCreateFileBlocks(md);
    // Neither directive has an adjacent code block — neither should be pre-extracted
    expect(blocks.has('src/hooks/useDisplayActions.ts')).toBe(false);
    expect(blocks.has('src/hooks/useActionNumbering.ts')).toBe(false);
  });
});

describe('extractCreateFileBlocks', () => {
  it('extracts code block from a standalone Target section', () => {
    const md = `
### Target: src/hooks/useDisplayActions.ts

\`\`\`typescript
export function useDisplayActions() {
  return { dispatch: () => {} };
}
\`\`\`
`;
    const blocks = extractCreateFileBlocks(md);
    expect(blocks.has('src/hooks/useDisplayActions.ts')).toBe(true);
    expect(blocks.get('src/hooks/useDisplayActions.ts')).toContain('useDisplayActions');
  });

  it('does NOT extract source block from adjacent section as Target content', () => {
    // This is the exact failure pattern from concourse-prototype:
    // ### Target: has only a signature (no code block)
    // ### Source Block: has a code block with // Context: lines
    // Old regex crossed the ### boundary and grabbed the source block
    const md = `
### Target: src/hooks/useDisplayActions.ts

Function signature: \`export function useDisplayActions(): DisplayActionsHook\`

### Source Block: useDisplayActions.ts (existing implementation)

\`\`\`typescript
// Context: existing code for reference
export function useDisplayActions() {
  return { actions: [] };
}
\`\`\`
`;
    const blocks = extractCreateFileBlocks(md);
    // Target section has no code block — should NOT be extracted
    expect(blocks.has('src/hooks/useDisplayActions.ts')).toBe(false);
  });

  it('does NOT put source block content under Target path when Target has only signature', () => {
    const md = `
### Target: src/utils/useActionNumbering.ts

Signature: \`export function useActionNumbering(actions: Action[]): string[]\`

### Source:

\`\`\`typescript
// Context: old implementation
const numbers = actions.map((_, i) => String(i + 1));
\`\`\`
`;
    const blocks = extractCreateFileBlocks(md);
    expect(blocks.has('src/utils/useActionNumbering.ts')).toBe(false);
  });

  it('extracts Target code block even when followed by a Source section', () => {
    const md = `
### Target: src/hooks/useDisplayActions.ts

\`\`\`typescript
import { useCallback } from 'react';
export function useDisplayActions(): DisplayActionsHook {
  const dispatch = useCallback(() => {}, []);
  return { dispatch };
}
\`\`\`

### Source Block: original file

\`\`\`typescript
// Context: old version
export function useDisplayActions() {
  return {};
}
\`\`\`
`;
    const blocks = extractCreateFileBlocks(md);
    expect(blocks.has('src/hooks/useDisplayActions.ts')).toBe(true);
    // Content should be from Target section, not Source
    const content = blocks.get('src/hooks/useDisplayActions.ts');
    expect(content).toContain('useCallback');
    expect(content).not.toContain('// Context:');
  });

  it('extracts multiple independent Target sections correctly', () => {
    const md = `
### Target: src/hooks/useDisplayActions.ts

\`\`\`typescript
export function useDisplayActions() { return {}; }
\`\`\`

### Target: src/hooks/useActionNumbering.ts

\`\`\`typescript
export function useActionNumbering() { return []; }
\`\`\`
`;
    const blocks = extractCreateFileBlocks(md);
    expect(blocks.has('src/hooks/useDisplayActions.ts')).toBe(true);
    expect(blocks.has('src/hooks/useActionNumbering.ts')).toBe(true);
    expect(blocks.get('src/hooks/useDisplayActions.ts')).toContain('useDisplayActions');
    expect(blocks.get('src/hooks/useActionNumbering.ts')).toContain('useActionNumbering');
  });

  it('ignores a Source section between two Target sections', () => {
    const md = `
### Target: src/hooks/useDisplayActions.ts

\`\`\`typescript
export function useDisplayActions() { return { a: 1 }; }
\`\`\`

### Source Block:

\`\`\`typescript
// Context: some reference
const x = 1;
\`\`\`

### Target: src/hooks/useActionNumbering.ts

\`\`\`typescript
export function useActionNumbering() { return ['1', '2']; }
\`\`\`
`;
    const blocks = extractCreateFileBlocks(md);
    expect(blocks.get('src/hooks/useDisplayActions.ts')).toContain('a: 1');
    expect(blocks.get('src/hooks/useActionNumbering.ts')).toContain("'1', '2'");
    // Source block should not appear under either target
    expect(blocks.get('src/hooks/useDisplayActions.ts')).not.toContain('Context:');
    expect(blocks.get('src/hooks/useActionNumbering.ts')).not.toContain('Context:');
  });
});
