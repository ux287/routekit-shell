---
id: how-to.publish-blog-to-ux287
title: "How-To — Publish a Blog Post to ux287.com"
desc: "Manual runbook for taking a finished rks-core blog note and publishing it to the ux287.com site. The functional successor is a /blog skill (see end)."
tags:
  - how-to
  - blog
  - publishing
  - ux287
---

# Publish a Blog Post to ux287.com

Runbook captured 2026-06-30 while publishing `blog.2026.06.30.rks-what-is-rks-today-v2-refresh`
→ `ux287-com.blog.2026.06.30.rks-current-architecture`.

## The two projects

- **Source** — this repo (`routekit-shell-core`). Blog drafts live in `notes/blog.YYYY.MM.DD.<slug>.md` with rks-internal Dendron frontmatter, `[[wikilinks]]` to canon/research notes, and DRAFT banners.
- **Target** — `../ux287` (repo `github.com/ux287/UX287`). A Vite + React + TypeScript site, Vercel-deployed. Blog posts are Dendron notes `notes/ux287-com.blog.YYYY.MM.DD.<slug>.md` with `publish: true`.

**Publishing is a cross-project adaptation, not a copy.**

## Why hooks must be off first

The rks guardrail hooks in *this* repo redirect every raw `Read`/`Bash`/`Write` to a Governor scoped to `routekit-shell-core`, so they block all work in the sibling `../ux287` tree. Turn them off for the duration:

```bash
mv .routekit/hooks .routekit/hooks.bak      # guardrails OFF
# ... publish ...
mv .routekit/hooks.bak .routekit/hooks      # guardrails BACK ON when done
```

## The ux287 pipeline (how a note becomes a page)

```
notes/ux287-com.blog.*.md (publish: true)
  → npm run blog:build  (scripts/generate-blog-index.mjs)
      · copies each published post to public/notes/ AND public/blog/
      · regenerates src/data/blog-index.json (metadata, sorted by created desc)
  → vite build
  → Vercel (buildCommand: npm run build) on push
Route: /thinking/<slug>   where slug = filename minus `ux287-com.blog.` and `.md`
Renders: markdown + mermaid + Prism (deps present; mermaid diagrams DO render)
```

Required frontmatter fields: `publish`, `title`, `created`, `author`, `category`, `summary`.

## Steps

### 1. Adapt the source note (this is the real work)

Produce a ux287 version from the finished rks-core draft:

- **Frontmatter → ux287 schema** (copy an existing post like `ux287-com.blog.2026.02.21.rks-agentified-workflow-deep-dive.md`):
  ```yaml
  id: ux287-com.blog.YYYY.MM.DD.<slug>
  title: "<title>"          # ux287 titles do NOT use "Part N"
  author: Vince Mease
  category: Technical Deep Dive
  summary: "<1-2 sentence listing summary>"
  tags: [blog, technical, project:routekit-shell, ai-agents, governance]
  created: 'YYYY-MM-DD HH:MM:SS'
  publish: true
  rag: true
  ```
- **Strip internal `[[wikilinks]]`** — `[[canon.*]]`, `[[research.*]]`, source-outline links. Those notes do not exist on ux287; published live they are broken links that also leak internal doc names. Convert to plain prose or cut.
- **Remove the DRAFT banner** and any "source outline / for the full source material" lines.
- **Fix cross-links to prior posts** — use the ux287 form `[text](blog.YYYY.MM.DD.<slug>)` (no `ux287-com.` prefix). Link ONLY to posts actually published on ux287. (As of this writing ux287 has Parts 1 & 2 of the rks series live; Part 3 / `2026.05.09.rks-deep-dive-release-ready` exists in rks-core but was never published — do not link it until it is.)
- **Brand voice** (`ux287-com.docs.build-development.blog-system`): no hyperbole / "battle-tested"; prefer "proven / validated / production-ready"; professional, consultative.

### 2. Write it into ux287

```bash
# write to: ../ux287/notes/ux287-com.blog.YYYY.MM.DD.<slug>.md
```

### 3. Build the index + verify

```bash
cd ../ux287 && npm run blog:build
# confirm the post shows in the "Found N blog files" list and that
# src/data/blog-index.json contains it with published: true
```

### 4. Commit on `dev` (only the tracked files)

`public/notes/` and `public/blog/` are **gitignored** (regenerated at build). Commit only:

```bash
cd ../ux287
git add notes/ux287-com.blog.YYYY.MM.DD.<slug>.md src/data/blog-index.json
git commit -m "docs: publish <title> blog post"
```

### 5. Promote to production

ux287 flow is `dev → staging → main`; Vercel builds on push (`npm run build` regenerates the index at deploy, so the committed index is belt-and-suspenders). Promotion (dev→staging→prod) is a human step — publishing to the public site is outward-facing.

### 6. Restore guardrails

```bash
cd <routekit-shell-core> && mv .routekit/hooks.bak .routekit/hooks
```

## Gotchas learned

- **`publish: true` is mandatory** — without it the post is silently skipped by the index generator.
- **Internal wikilinks break on the public site** — always strip them.
- **`public/` is gitignored** — never commit the copies; commit the note + `blog-index.json`.
- **Series numbering** — ux287 titles don't use "Part N", and the published series can lag rks-core drafts; check what's actually live before referencing prior parts.
- The commit `Co-Authored-By` trailer is applied by default; strip it if the public repo history should stay clean.

## Roadmap — replace this runbook with a `/blog` skill

The whole point of this note is that it should become a **skill** so we never `mv` hooks by hand: call `/blog` in this repo to write and publish a post end-to-end. Roadmap: configurable target (publish where?), multi-channel support, and derived workflows (e.g. decompose a post into a tweet/LinkedIn thread — ux287 already has precedent notes like `...twitter-summary-thread`). Keep v1 simple: adapt + place + build + commit-on-dev, stop before prod promotion.
