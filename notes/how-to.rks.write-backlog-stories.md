---
id: p10ue4rahr57dr94gu80y9j
title: How to Write Backlog Stories
desc: Guide to writing effective stories for RKS planning
updated: 1769717971969
created: 1769717971969
---

# How to Write Backlog Stories

A well-written story is the foundation of successful RKS planning. This guide covers the structure, patterns, and common pitfalls.

## Story Structure

Every story needs these sections:

```markdown
---
id: "backlog.feat.my-feature"
title: "Add my feature"
desc: "Brief description"
status: "not-implemented"
phase: "draft"
targetFiles:
  - src/components/MyComponent.tsx
  - src/utils/helpers.ts
---

## Problem

What issue exists? Why does it matter?

## Goal

What should be true when this is done?

## Target Files

- src/components/MyComponent.tsx - Add new component
- src/utils/helpers.ts - Add helper function

## Acceptance Criteria

- [ ] Component renders correctly
- [ ] Helper function returns expected values
- [ ] Tests pass
```

## The Key Sections

### Problem

Be specific about what's wrong or missing. Avoid vague statements.

**Bad**: "The UI needs improvement"
**Good**: "Users cannot filter the product list by category, forcing them to scroll through all 500+ items"

### Goal

State the end result, not the implementation steps.

**Bad**: "Add a dropdown component with onChange handler"
**Good**: "Users can filter products by category with results updating instantly"

### Target Files

List every file that will be created or modified. This is critical for planning:

```yaml
targetFiles:
  - src/components/ProductFilter.tsx    # New file
  - src/pages/Products.tsx              # Add filter integration
  - src/hooks/useProducts.ts            # Add filter parameter
```

The planner uses `targetFiles` to:
- Read existing code for context
- Validate that referenced files exist
- Scope the changes appropriately

### Acceptance Criteria

Write testable conditions. Each criterion should be verifiable:

```markdown
## Acceptance Criteria

- [ ] Filter dropdown appears above product grid
- [ ] Selecting a category shows only matching products
- [ ] "All" option shows all products
- [ ] Filter state persists on page refresh
- [ ] Works on mobile (responsive)
```

## Story Types

Use naming conventions to indicate story type:

| Prefix | Purpose | Example |
| ------ | ------- | ------- |
| `backlog.feat.*` | New features | `backlog.feat.user-auth` |
| `backlog.fix.*` | Bug fixes | `backlog.fix.login-redirect` |
| `backlog.refactor.*` | Code improvements | `backlog.refactor.api-client` |
| `backlog.docs.*` | Documentation | `backlog.docs.api-reference` |
| `backlog.chore.*` | Maintenance | `backlog.chore.update-deps` |

## SEARCH/REPLACE Blocks

For precise modifications, include SEARCH/REPLACE blocks in the story body:

```markdown
## Implementation Hint

The filter should be added to the Products page header:

<<<<<<< SEARCH
export function Products() {
  const products = useProducts();
  return (
    <div className="products-page">
      <h1>Products</h1>
=======
export function Products() {
  const [category, setCategory] = useState<string | null>(null);
  const products = useProducts({ category });
  return (
    <div className="products-page">
      <ProductFilter value={category} onChange={setCategory} />
      <h1>Products</h1>
>>>>>>> REPLACE
```

**Important**: SEARCH blocks must match the file exactly, including:
- Whitespace and indentation
- Comments
- Surrounding context

If the SEARCH doesn't match, planning fails. Use `rks_code_context` to get exact file content.

## Common Mistakes

### 1. Missing targetFiles

```yaml
# Bad - no targetFiles
targetFiles:

# Good - specific files listed
targetFiles:
  - src/components/Button.tsx
```

### 2. Vague Acceptance Criteria

```markdown
# Bad
- [ ] Works correctly
- [ ] Looks good

# Good
- [ ] Button shows loading spinner when isLoading=true
- [ ] Button is disabled during loading
- [ ] Spinner is centered within button bounds
```

### 3. Too Many Files

Keep stories focused. If you're touching 10+ files, split into smaller stories:

```markdown
# Instead of one giant story:
backlog.feat.complete-auth-system

# Split into focused stories:
backlog.feat.auth-login-form
backlog.feat.auth-signup-form
backlog.feat.auth-password-reset
backlog.feat.auth-session-management
```

### 4. Implementation in Problem

Don't put implementation details in the Problem section:

```markdown
# Bad - implementation details in problem
## Problem
We need to add a useState hook for the filter and pass it to useProducts.

# Good - describes the actual problem
## Problem
Users have no way to narrow down the product list without scrolling.
```

## Creating Stories

Use `rks_story_create` for proper structure:

```json
rks_story_create {
  "projectId": "my-project",
  "name": "product-filter",
  "title": "Add product category filter",
  "desc": "Allow users to filter products by category"
}
```

Or use `dendron_create_note` for manual creation:

```json
dendron_create_note {
  "vault": "notes",
  "fname": "backlog.feat.product-filter"
}
```

## Validating Stories

Before planning, validate your story:

1. **Check targetFiles exist**: `rks_code_context` to verify paths
2. **Verify SEARCH blocks match**: Copy exact content from files
3. **Test acceptance criteria**: Each should be independently verifiable

Use `rks_plan_ready` to check if a story passes all gates:

```json
rks_plan_ready {
  "projectId": "my-project",
  "problemId": "backlog.feat.product-filter"
}
```

## Templates

For common patterns, use story templates:

- **react-component**: New React component with tests
- **api-endpoint**: New API route with validation
- **cli-command**: New CLI command with help

```json
rks_story_create {
  "projectId": "my-project",
  "name": "user-avatar",
  "template": "react-component"
}
```

## See Also

- [[how-to.rks]] - Complete RKS workflow guide
- [[how-to.rks.story-lifecycle]] - Phase transitions and gates
