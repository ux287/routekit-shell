import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const slug = process.env.ROUTEKIT_SLUG || process.argv[2];
if (!slug) {
  console.error('ROUTEKIT_SLUG not set; usage: node scripts/setup/post-init.mjs <slug>');
  process.exit(1);
}

const projectDir = process.cwd();
const notesDir = path.join(projectDir, 'notes');
if (!fs.existsSync(notesDir)) fs.mkdirSync(notesDir, { recursive: true });

// Create essential Dendron vault files
const cacheFile = path.join(notesDir, '.dendron.cache.json');
const rootFile = path.join(notesDir, 'root.md');
const schemaFile = path.join(notesDir, 'root.schema.yml');

// Create .dendron.cache.json
if (!fs.existsSync(cacheFile)) {
  fs.writeFileSync(cacheFile, JSON.stringify({
    version: 0,
    activationTime: Date.now()
  }, null, 2));
}

// Create root.md
if (!fs.existsSync(rootFile)) {
  fs.writeFileSync(rootFile, `---
id: root
title: ${slug} Notes
desc: 'Documentation and design system for ${slug}'
updated: ${Date.now()}
created: ${Date.now()}
---

# ${slug.toUpperCase()} Notes

This vault contains documentation and design system notes for **${slug}**.

## Structure

- **docs.*** - Technical documentation, workflows, and guides
- **design.*** - Design system, brand guidelines, and visual standards

## Getting Started

Navigate through the notes using Dendron's lookup feature (\`Cmd+L\` in VS Code).
`);
}

// Create root.schema.yml
if (!fs.existsSync(schemaFile)) {
  fs.writeFileSync(schemaFile, `version: 1
imports: []
schemas:
  - id: root
    children:
      - docs
      - design
    title: root
    parent: root
  - id: docs
    children:
      - agent-workflows
      - build-development
      - deployment
      - mcp-integration
      - rag-system
      - troubleshooting
    title: Documentation
    parent: root
  - id: design
    children:
      - brand
      - design-system
    title: Design System
    parent: root
  - id: brand
    children:
      - color-pallette
      - markets-and-audiences
      - voice
    title: Brand Guidelines
    parent: design
  - id: design-system
    children:
      - components
      - patterns
      - layout
      - spacing
      - typography
    title: Design System
    parent: design
`);
}

// Seed from routekit-shell vault
// Assumes routekit-shell is the current CLI package context (we run this from template project)
execSync(`routekit notes seed --toSlug="${slug}" --toVault="${notesDir}"`, { stdio: 'inherit' });

console.log(JSON.stringify({ ok: true, seeded: true, slug, notesDir, dendronFiles: true }));
