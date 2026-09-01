---
id: 9r30dpm6qi9v0heucdc9lr9
title: Write Backlog Stories
desc: >-
  Guide to writing well-structured backlog stories for RKS planning and
  execution
updated: 1769717886490
created: 1769717886490
---

# How to Write Backlog Stories

Stories are the atomic unit of work in RKS. A well-written story enables deterministic planning and execution.

## Story Structure

### Frontmatter (Required)

```yaml
---
id: backlog.feature-name
title: Short descriptive title
desc: One-line description of what this accomplishes
status: not-implemented
phase: draft
targetFiles:
  - path/to/file1.js
  - path/to/file2.js
---
```

**Key fields:**

| Field | Purpose |
|-------|---------|
| `id` | Unique identifier, matches filename (without .md) |
| `title` | Human-readable title |
| `desc` | Brief description for search/discovery |
| `status` | `not-implemented` or `implemented` |
| `phase` | Current lifecycle phase |
| `targetFiles` | Files this story will modify or create |

### Body Sections

#### Problem

Describe what's broken, missing, or suboptimal. Be specific.

```markdown
## Problem

The login form doesn't validate email format before submission,
leading to server errors when malformed emails are submitted.
```

#### Goal

State the desired outcome clearly. What will be true when this is done?

```markdown
## Goal

Add client-side email validation to the login form that:
- Validates email format before submission
- Shows inline error message for invalid emails
- Prevents form submission until valid
```

#### Target Files

Declare which files will be touched and whether they're new or existing.

```markdown
## Target Files

// CREATE FILE: src/utils/emailValidator.js
// CREATE FILE: src/utils/emailValidator.test.js
src/components/LoginForm.jsx
```

**Important:** Use `// CREATE FILE: path` for files that don't exist yet. This tells validation to skip existence checks for these paths. Files without the directive must already exist.

#### Acceptance Criteria

Testable conditions that define "done". Use checkboxes.

```markdown
## Acceptance Criteria

- [ ] Email input validates on blur
- [ ] Invalid emails show red border and error message
- [ ] Submit button is disabled when email is invalid
- [ ] Valid email format: contains @ and domain
```

## Explicit Edits (Reviewer Mode)

For precise control over code changes, include explicit edit blocks. The planner extracts these verbatim instead of generating code.

### SEARCH/REPLACE Pattern

For modifying existing files:

```markdown
## Edits

### Edit 1: Add validation function

File: src/components/LoginForm.jsx

SEARCH:
\`\`\`javascript
export function LoginForm() {
  return (
\`\`\`

REPLACE:
\`\`\`javascript
import { isValidEmail } from '../utils/emailValidator';

export function LoginForm() {
  const [emailError, setEmailError] = useState(null);
  return (
\`\`\`
```

**Rules for SEARCH/REPLACE:**

1. SEARCH must match existing code exactly (whitespace matters)
2. Include enough context to be unique in the file
3. REPLACE contains the complete replacement text
4. One edit per logical change

### CREATE FILE Pattern

For new files, use CREATE FILE blocks:

```markdown
### CREATE FILE: src/utils/emailValidator.js

\`\`\`javascript
export function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}
\`\`\`
```

The path after `CREATE FILE:` should match an entry in the Target Files section marked with `// CREATE FILE:`.

## Story Types

### Feature Stories

New functionality. May include both new files and modifications.

```
backlog.feat.user-authentication.md
backlog.feat.dark-mode-toggle.md
```

### Scaffolding Stories

Create initial project structure. Primarily CREATE FILE blocks.

```
backlog.feat.scaffold-react-vite.md
backlog.feat.init-express-api.md
```

For scaffolding stories, all targetFiles will typically have `// CREATE FILE:` directives.

### Fix Stories

Bug fixes. Focused, typically 1-2 files, using SEARCH/REPLACE.

```
backlog.fix.login-redirect-loop.md
backlog.fix.date-parsing-timezone.md
```

### Refactor Stories

Code improvements without behavior change.

```
backlog.refactor.extract-auth-service.md
```

## Common Mistakes

### Missing CREATE FILE Directive

```markdown
# Bad - new file but no directive, validation will fail
## Target Files

src/utils/newHelper.js
```

```markdown
# Good - directive tells validation to skip existence check
## Target Files

// CREATE FILE: src/utils/newHelper.js
```

### Vague Acceptance Criteria

```markdown
# Bad
- [ ] Login works better

# Good
- [ ] Login form validates email format on blur
- [ ] Invalid email shows error "Please enter a valid email"
```

### SEARCH That Won't Match

```markdown
# Bad - might not match due to whitespace
SEARCH:
\`\`\`javascript
function foo(){return true}
\`\`\`

# Good - matches actual file formatting
SEARCH:
\`\`\`javascript
function foo() {
  return true;
}
\`\`\`
```

### Mismatched Target Files and Edits

Every file in Target Files should have a corresponding edit block, and vice versa. If you have:

```markdown
## Target Files

// CREATE FILE: src/new.js
src/existing.js
```

Then you need:

```markdown
## Edits

### CREATE FILE: src/new.js
...

### Edit 1: Update existing.js
File: src/existing.js
SEARCH: ...
REPLACE: ...
```

## Quick Reference

1. Create story: `rks_story_create { projectId: "my-project", name: "my-feature" }`
2. Add Target Files section with `// CREATE FILE:` for new files
3. Write Problem, Goal, Acceptance Criteria
4. Add explicit edit blocks (SEARCH/REPLACE or CREATE FILE)
5. Run `rks_plan` to generate execution plan
6. Run `rks_exec` to apply changes

## See Also

- [[how-to.rks]] - Overall RKS workflow