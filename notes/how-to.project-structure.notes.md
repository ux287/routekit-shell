---
id: rdctvflqtwo1r8kmxgqnlhj
title: Notes
desc: Project structure documentation for RouteKit Shell
updated: '2025-09-02T16:22:55.444Z'
created: '2025-09-02T16:22:55.444Z'
---

# Documentation Structure (notes/)

## Dendron Vault Structure

RouteKit uses hierarchical documentation following Dendron conventions:

```
notes/
├── [project-slug].index.md           # Main project overview
├── [project-slug].how-to.*.md        # How-to guides
├── [project-slug].docs.*.md          # API documentation
├── [project-slug].design.*.md        # Design system docs
└── [project-slug].prototype.*.md     # Prototype notes
```

## Naming Convention

### Project Slug Prefix

All notes start with your project slug:

- `my-app.index.md`
- `my-app.how-to.getting-started.md`
- `my-app.docs.api.md`

### Hierarchical Structure

Use dots to create hierarchy:

```
my-app.how-to.md                    # Section index
my-app.how-to.getting-started.md    # Level 2
my-app.how-to.getting-started.installation.md # Level 3
```

## Documentation Categories

### `how-to.*` - Practical Guides

Step-by-step instructions for common tasks:

- `how-to.getting-started.*` - Setup and first steps
- `how-to.development-workflow.*` - Daily development
- `how-to.deployment.*` - Publishing your app

### `docs.*` - Reference Documentation

Technical reference and API documentation:

- `docs.api.*` - API endpoints and functions
- `docs.configuration.*` - Configuration options
- `docs.troubleshooting.*` - Common issues

### `design.*` - Design System

UI components and design guidelines:

- `design.components.*` - Component documentation
- `design.patterns.*` - Design patterns
- `design.tokens.*` - Design tokens and variables

### `prototype.*` - Experimental

Prototype notes and experiments (excluded from RAG by default):

- `prototype.experiments.*` - Code experiments
- `prototype.ideas.*` - Feature ideas

## Frontmatter Configuration

All documentation supports YAML frontmatter:

```yaml
---
title: Page Title
summary: Brief description for listings
tags: ["tag1", "tag2"]
order: 1
section: how-to
rag: true  # Include in RAG embeddings
---
```

### Key Fields

- `title` - Display title
- `summary` - Brief description for indexes
- `tags` - Categorization tags
- `order` - Ordering within section
- `section` - Parent section
- `rag` - Include/exclude from RAG embeddings

## RAG Integration

### Included by Default

- `how-to.*` - How-to guides
- `docs.*` - Documentation
- `design.*` - Design system docs

### Excluded by Default

- `notes.*` - Personal notes
- `daily.*` - Daily notes
- `prototype.*` - Prototype files

### Override with Frontmatter

```yaml
# Force include
rag: true

# Force exclude  
rag: false
```

## Content Organization Tips

### Keep Documents Focused

Each document should cover one specific topic:

```
✅ Good:
my-app.how-to.getting-started.installation.md
my-app.how-to.getting-started.first-project.md

❌ Too broad:
my-app.how-to.getting-started.md (covers everything)
```

### Use Semantic Titles

Make titles searchable and descriptive:

```
✅ Good:
"Installing RouteKit CLI"
"Creating Your First Project"
"Deploying to Vercel"

❌ Less helpful:
"Setup"
"Part 1"
"Instructions"
```

### Link Between Documents

Use relative links to connect related topics:

```markdown
See also: [Project Structure](routekit-shell.how-to.project-structure.md)
```

---

**Next:** [Development Workflow →](routekit-shell.how-to.development-workflow.daily-cycle.md)
