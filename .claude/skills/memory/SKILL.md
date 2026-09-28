---
name: memory
description: |
  Save an agent memory as a project-local Dendron note atomically — write → commit → embed,
  commit strictly before embed. Invoked by the Dispatcher when the memory-write redirect
  hook routes a ~/.claude/projects/<slug>/memory/<file>.md Write here. Not part of any
  larger orchestration flow — a memory save is a lightweight Dispatcher-driven operation.
user-invocable: true
disable-model-invocation: false
verbosity: silent
---

# /memory — save an agent memory atomically

Save an agent memory as a project-local Dendron note. Restores the invariant *"nothing
embedded that is not committed"* on the Dispatcher memory-save path.

## When this skill runs

Two invocation paths:

1. **Hook redirect** — the `redirect-edit-to-governor.mjs` memory branch denies a `Write`
   whose target is inside `~/.claude/projects/<slug>/memory/` and emits a `REDIRECT ORDER`
   directing the Dispatcher to invoke `/memory` with the derived slug and the content the
   Write was carrying.

2. **Direct invocation** — `/memory` from the user.

## Arguments

The skill is invoked with two fields:

- `slug` — the memory slug. Derived by the redirect hook from the harness memory
  filename basename without `.md`. Becomes the Dendron note id `memories.<slug>` and the
  on-disk path `notes/memories.<slug>.md`.
- `content` — the memory body markdown.

## Instructions

### Step 1: save the memory via `commitAndEmbedNote()`

Use the Bash tool to invoke the shared wrapper. The wrapper performs three steps in
strict order — commit before embed — and reuses existing exports without reimplementation.

Reference invocation (substitute the slug and content from the skill arguments,
JSON-escaped):

```
node -e "import('./packages/mcp-rks/src/shared/commit-and-embed-note.mjs').then(m => m.commitAndEmbedNote({ projectRoot: process.cwd(), slug: SLUG, content: CONTENT })).then(r => console.log(JSON.stringify(r)))"
```

What the wrapper does internally:

1. `writeNoteRaw(notePath, formattedContent, { skipEmbed: true })` — write the note
   atomically, suppressing the write-time auto-embed. The `skipEmbed` flag is the
   wrinkle-handler; without it, `writeNoteRaw` spawns a background embed on write that
   would defeat commit-before-embed by call-ordering alone.
2. `git add <notePath>` — stage the note.
3. `commitAndEmbed(projectRoot, "docs(memory): save <slug>")` — git commit, then embed
   the now-committed file. Commit strictly precedes embed.

### Step 2: report

- **Success** — report the new commit SHA, the note path, and any `ragEmbedWarning`
  returned (the note is committed and durable; only the embed step warned).
- **Commit failure** — report the commit error. The note was written to disk and staged
  but is not committed; no embed ran. Decide whether to retry or unstage.
- **Embed failure after successful commit** — the note is durable in git. Surface the
  embed warning; the index will refresh on the next embed.

## Design notes

- This skill is NOT part of any larger orchestration flow. A memory save is a lightweight
  Dispatcher-driven operation, not a development task — consistent with the parent
  feature's deliberate design.
- The wrapper composes existing exports — `writeNoteRaw`, `commitAndEmbed`, and
  (transitively) `runRagEmbed`. Thin glue, no reimplementation.
- The `skipEmbed: true` flag on `writeNoteRaw` is added in this story and is the
  wrinkle-handler that makes commit-before-embed achievable.
