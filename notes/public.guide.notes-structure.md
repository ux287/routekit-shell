---
id: 0fdljb2ymuhv2tj3rpkoega
title: Notes Structure Guide
desc: >-
  How notes are organized in rks projects — Dendron hierarchy, namespace
  conventions, frontmatter schema, and RAG embedding fields.
updated: 1746843600000
created: 1746843600000
---

# Notes Structure Guide

rks uses a Dendron-style hierarchical notes system. All notes live in `notes/` and use dot-separated namespaces as their filename. This guide covers naming conventions, frontmatter schema, namespace table, and how RAG interacts with notes.

## File Layout

```
notes/
├── backlog.feat.*.md          # Story notes (managed by rks)
├── public.canon.*.md          # Durable reference — authoritative docs
├── public.guide.*.md          # Procedural how-to guides
├── research.YYYY.MM.DD.*.md   # Research papers (created by Research Governor)
├── how-to.*.md                # Legacy how-to notes (being migrated to public.guide.*)
└── z_archive.*.md             # Archived/deprecated (excluded from RAG)
```

## Naming Convention

Filenames use dot-separated hierarchy with no project-slug prefix. Note IDs in frontmatter match the filename without `.md`:

```
notes/public.canon.getting-started.md   →  id: canon.getting-started
notes/public.guide.rag-usage.md         →  id: guide.rag-usage
notes/backlog.feat.my-feature.md        →  id: backlog.feat.my-feature
```

Do **not** prefix note IDs with the project slug. The `notes/` directory is the vault — it is not namespaced by project slug in rks.

### Hierarchy levels

```
public.canon.getting-started.md        # level 3: namespace.type.topic
public.guide.rag-usage.md              # level 3
research.2026.05.09.public-library.md  # level 4: research.YYYY.MM.DD.topic
backlog.feat.my-feature.sub-task.md    # level 4+
```

## Frontmatter Schema

The embed pipeline reads these fields from each note's YAML frontmatter:

| Field | Type | Required | Purpose |
|---|---|---|---|
| `id` | string | yes | Unique note identifier (matches filename sans `.md`) |
| `title` | string | yes | Human-readable title for search results |
| `desc` | string | recommended | One-line description; used as L1 fidelity preview in RAG results |
| `created` | number (ms) | yes | Unix timestamp in milliseconds |
| `updated` | number (ms) | yes | Unix timestamp in milliseconds — updated on every edit |
| `rag` | boolean | no | `true` to force-include; `false` to force-exclude from embeddings |

Additional frontmatter fields (like `phase`, `targetFiles`, `testRequirements`) are used by rks workflow tools and are preserved but not indexed by the embed pipeline.

**Example valid frontmatter:**

```yaml
---
id: guide.rag-usage
title: RAG Usage Guide
desc: How to query the RAG index and choose between rks_rag_query and /research.
created: 1746843600000
updated: 1746843600000
---
```

## Namespace Table

| Namespace | Purpose | Who creates |
|---|---|---|
| `public.canon.*` | Durable reference — authoritative facts about rks internals | Research Governor, human |
| `public.guide.*` | Procedural how-to guides for rks users | Research Governor, human |
| `backlog.feat.*` | Story notes for the rks development backlog | PO Governor |
| `backlog.epic.*` | Epic-level groupings of related stories | PO Governor |
| `research.YYYY.MM.DD.*` | Research papers produced by the Research Governor | Research Governor |
| `how-to.*` | Legacy how-to notes (pre-public.guide migration) | Human (legacy) |
| `z_archive.*` | Deprecated/archived notes; excluded from RAG | Human |
| `z_implemented.*` | Implemented stories moved out of active backlog | rks automation |
| `drafts.*` | Work-in-progress notes; excluded from RAG by default | Human |

## RAG Inclusion Rules

Notes are included in the RAG index by default unless:

- `rag: false` in frontmatter
- Filename starts with `z_archive.` or `drafts.`
- Filename starts with `daily.` or `prototype.`

Force-include a normally-excluded note with `rag: true`. Force-exclude a normally-included note with `rag: false`.

## Creating Notes

**Via rks tools** (recommended): Use `dendron_create_note` (for Dispatcher/Governor use) or the `rks_story_create` tool for story notes.

**Manually**: Create a `.md` file in `notes/` with valid frontmatter. Use the current Unix millisecond timestamp for `created` and `updated`. Run `rks_rag_embed` to index the new note.

## Updating Notes

When you edit a note's content, update the `updated` timestamp. The `dendron_update_field` tool handles this automatically. For manual edits, use `Date.now()` in milliseconds.

After edits, re-embed: `rks_rag_embed { "projectId": "...", "files": ["notes/your-note.md"] }` to index just the changed file.

---

*Versioning sentinel: public.guide.notes-structure v1 — 2026-05-10. Note IDs do not use project slug prefix. Embed pipeline fields: id, title, desc, created, updated, rag. Update this note when the frontmatter schema or namespace table changes.*
