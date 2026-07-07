---
id: how-to.project-structure
title: Project Structure
desc: Documentation for the RouteKit Shell framework
updated: '2025-09-02T16:22:55.445Z'
created: '2025-09-02T16:22:55.445Z'
---

# Understanding RouteKit Project Structure

## Complete Project Layout

```
my-project/
├── src/                    # Application source code
│   ├── components/         # Reusable UI components
│   │   └── Layout.tsx     # Main layout wrapper
│   ├── pages/             # Route-based page components
│   │   ├── HomePage.tsx   # Landing page
│   │   ├── DocsPage.tsx   # Documentation listing
│   │   └── routekit-demo.tsx # Component showcase
│   ├── utils/             # Utility functions
│   │   └── contentLoader.ts # Dynamic content loading
│   ├── styles/            # Styling and CSS
│   │   └── globals.css    # Global styles with Tailwind
│   └── main.tsx           # Application entry point
├── scripts/               # Automation and tooling
│   ├── rag/              # RAG (Retrieval Augmented Generation)
│   │   ├── init.mjs      # Initialize vector database
│   │   ├── embed.mjs     # Embed documentation
│   │   ├── query.mjs     # Search embedded content
│   │   └── utils.mjs     # Project-agnostic utilities
│   └── mcp/              # Model Context Protocol servers
│       └── rag-server.mjs # MCP server for Claude Code
├── notes/                 # Dendron documentation vault
│   └── [project-slug].*.md # Hierarchical documentation
├── public/                # Static assets
├── .vscode/              # VS Code workspace settings
├── package.json          # Dependencies and scripts
├── vite.config.ts        # Vite build configuration
├── tailwind.config.js    # Tailwind CSS configuration
├── tsconfig.json         # TypeScript configuration
└── README.md             # Project documentation
```

## Source Code Organization (`src/`)

### Components Directory

**Purpose**: Reusable UI components that can be used across multiple pages.

```typescript
// src/components/Layout.tsx
export default function Layout() {
  return (
    <div className="min-h-screen">
      <nav>...</nav>
      <main>
        <Outlet /> {/* React Router outlet */}
      </main>
    </div>
  );
}
```

**Best Practices**:

- One component per file
- Use TypeScript interfaces for props
- Export as default
- Include JSDoc comments for complex components

### Pages Directory

**Purpose**: Top-level route components that represent distinct pages/views.

```typescript
// src/pages/HomePage.tsx
export default function HomePage() {
  return <div>Welcome to our app!</div>;
}
```

**Naming Convention**:

- `HomePage.tsx` → `/` route
- `DocsPage.tsx` → `/docs` route
- `BlogPage.tsx` → `/blog` route

### Utils Directory

**Purpose**: Pure functions, API clients, and shared utilities.

```typescript
// src/utils/contentLoader.ts
export async function loadDocs(): Promise<DocItem[]> {
  // Load and parse documentation files
}
```

## Scripts Directory (`scripts/`)

### RAG System (`scripts/rag/`)

**Purpose**: AI-powered documentation search and embedding.

- **`init.mjs`** - Creates and initializes LanceDB vector database
- **`embed.mjs`** - Processes markdown files and creates embeddings
- **`query.mjs`** - Searches embedded content with semantic similarity
- **`utils.mjs`** - Project-agnostic helper functions

**Usage**:

```bash
npm run rag:init     # Setup database
npm run rag:embed    # Process documentation
npm run rag:query -- "search term" 5  # Search with limit
```

### MCP Integration (`scripts/mcp/`)

**Purpose**: Model Context Protocol servers for Claude Code integration.

- **`rag-server.mjs`** - Exposes RAG functionality to Claude Code
- Auto-detects project context
- Provides `rag_init`, `rag_embed`, `rag_query` tools

## Documentation System (`notes/`)

### Dendron Vault Structure

RouteKit uses hierarchical documentation following Dendron conventions:

```
notes/
├── [project-slug].index.md           # Main project overview
├── [project-slug].how-to.*.md        # How-to guides
├── [project-slug].docs.*.md          # API documentation
├── [project-slug].design.*.md        # Design system docs
└── [project-slug].prototype.*.md     # Prototype notes
```

**Example**:

```
my-app.index.md
my-app.how-to.getting-started.md
my-app.how-to.deployment.md
my-app.docs.api.md
my-app.design.components.md
```

### Frontmatter Configuration

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

## Configuration Files

### `package.json`

Contains project metadata, dependencies, and npm scripts:

```json
{
  "scripts": {
    "dev": "vite",                    # Development server
    "build": "vite build",           # Production build
    "rag:embed": "node scripts/rag/embed.mjs",  # RAG commands
    "mcp:rag": "node scripts/mcp/rag-server.mjs" # MCP server
  }
}
```

### `vite.config.ts`

Vite build tool configuration with React plugin.

### `tailwind.config.js`

Tailwind CSS configuration with custom design tokens from `@routekit/design`.

### `tsconfig.json`

TypeScript compiler configuration with strict type checking.

## Key Design Principles

### 1. **Convention Over Configuration**

- Predictable file locations
- Standard naming patterns
- Minimal configuration required

### 2. **AI-First Architecture**

- RAG system for searchable documentation
- MCP integration for Claude Code
- Structured data formats

### 3. **Rapid Prototyping**

- Hot module replacement
- Zero-config TypeScript
- Pre-configured tooling

### 4. **Scalable Structure**

- Clear separation of concerns
- Modular component architecture
- Extensible utility functions

## Customization Points

### Adding New Pages

1. Create component in `src/pages/`
2. Add route to `src/main.tsx`
3. Update navigation in `src/components/Layout.tsx`

### Adding Documentation

1. Create markdown file in `notes/` following naming convention
2. Run `npm run rag:embed` to make searchable
3. Add to content index if using dynamic loading

### Extending RAG System

1. Modify patterns in `scripts/rag/utils.mjs`
2. Customize embedding logic in `scripts/rag/embed.mjs`
3. Adjust search behavior in `scripts/rag/query.mjs`

---

**Next:** [Development Workflow →](routekit-shell.how-to.development-workflow.md)
