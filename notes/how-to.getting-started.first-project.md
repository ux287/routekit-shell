---
id: how-to.getting-started.first-project
title: First Project
desc: Getting started guide for RouteKit Shell framework
updated: '2025-09-02T16:22:55.452Z'
created: '2025-09-02T16:22:55.452Z'
---

# Creating Your First RouteKit Project

## Initialize New Project

### Basic Project Creation

```bash
routekit create my-app --template=web
```

### Navigate to Project

```bash
cd my-app
```

### Install Dependencies

```bash
npm install
```

## Start Development

### Run Development Server

```bash
npm run dev
```

Your application will be available at: `http://localhost:5173`

### Expected Output

```
  ➜  Local:   http://localhost:5173/
  ➜  Network: use --host to expose
  ➜  press h to show help
```

## Verify Setup

### Check Homepage

1. Open `http://localhost:5173` in your browser
2. You should see the RouteKit Shell homepage
3. Navigation should include: Home, Docs, Guides, Blog, Demo

### Test Hot Reload

1. Edit `src/pages/HomePage.tsx`
2. Change the title text
3. Save the file
4. Browser should update automatically

### Verify Routes

Test that all routes work:

- `/` - Homepage
- `/docs` - Documentation page
- `/guides` - Guides page
- `/blog` - Blog page
- `/demo` - Component demo

## Project Structure Overview

```
my-app/
├── src/
│   ├── components/     # React components
│   ├── pages/         # Route pages
│   ├── utils/         # Utility functions
│   └── styles/        # CSS and styling
├── scripts/
│   ├── rag/          # RAG system scripts
│   └── mcp/          # MCP servers
├── notes/            # Documentation vault
└── package.json      # Project configuration
```

## Next Steps

1. **Explore the codebase** - Understand the generated structure
2. **Read documentation** - Check out `/docs` for detailed guides
3. **Try the design system** - Visit `/demo` to see components
4. **Enable AI assistance** - Set up the RAG system

---

**Next:** [Project Structure →](routekit-shell.how-to.project-structure.overview.md)
