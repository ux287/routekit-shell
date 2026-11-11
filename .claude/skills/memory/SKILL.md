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

### Step 1: save the memory via the `rks_memory_save` MCP tool

Call the MCP tool directly — no Bash, no shell, and no Governor token is needed
(`rks_memory_save` is token-free because it can write nothing but
`notes/memories.<slug>.md`). Substitute the slug and content from the skill arguments:

`mcp__rks__rks_memory_save({ projectId: 'routekit-shell', slug: '<slug>', content: '<content>' })`

Optional fields: `title` (defaults to the slug) and `desc`. The tool has no path input;
the project root is resolved from the MCP server's environment, not from `projectId`.

Refusals (returned as `ok: false` with an `error`, nothing written, nothing committed):

- the slug does not match `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$` or contains `..`
  (dotted slugs such as `2026.10.02.user-pref` are fine);
- the current branch is a protected branch (production/`main`, and the integration branch
  in a three-branch topology). Switch to a working or feature branch and retry.

What the tool does internally (the shared `commitAndEmbedNote` legacy memory form):

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
- **Refusal** (`ok: false` before writing — invalid slug or protected branch) — report the
  error verbatim. Nothing was written or committed.
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
