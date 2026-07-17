---
id: z0xs87tvww60telkl95sxyy
title: Design Riff Sessions
desc: >-
  How the Dispatcher and user collaborate in freeform design — docs, sketches,
  proto-stories
updated: 1772217784615
created: 1772216115952
---

## Purpose

Freeform collaborative design. The user and Dispatcher work together to explore ideas, iterate on documentation, sketch story outlines, and refine system design. No Governor chain — this is a conversation with write access to docs.

Design Riff answers: **"What are we building and why?"**

## What Makes a Design Riff Different

Every other operation in the pipeline is a Governor chain: a formal sequence of MCP tool calls driven by a prompt. A design riff is not. It's the Dispatcher and user talking, with the Dispatcher making direct MCP calls (dendron_create_note, dendron_edit_note) in an open flow session. There's no chain to complete, no status to return.

| | Governor Chain | Design Riff |
|---|---|---|
| **Who drives** | Governor prompt | User + Dispatcher |
| **Session type** | Story flow or open flow (Governor) | Open flow (Dispatcher) |
| **Iteration** | Single pass — Governor runs and returns | Many passes — back and forth until satisfied |
| **Ship trigger** | Auto-chain on Governor return | User says "ship these docs" |
| **Scope** | Defined by prompt and state machine | Flexible — user directs in real time |

## Session Setup

A design riff uses `guardrails_off` with a distinct session type:

```
rks_guardrails_off({
  projectId,
  reason: "Design riff — iterative documentation",
  scope: "write"   // docs writable, code protected
})
```

The Dispatcher gets a Governor token via `rks_governor_init` (open flow, no problemId) to authorize dendron tool calls. This is the same mechanism Research and PO Governors use, but without a formal chain — the Dispatcher holds the token and makes calls as the conversation flows.

## What You Can Do in a Design Riff

### Write and iterate on docs
- `how-to.*` — operational documentation (like this series)
- `design.*` — architectural design notes
- `research.*` — research findings
- `notes.*` — general notes
- New namespaces on the fly if the topic doesn't fit existing ones

### Sketch proto-stories
You can draft the bones of a `backlog.feat.*` — problem statement, rough solution, initial ACs, candidate target files. But you **cannot finalize it**:
- Cannot set `phase: 'ready'` (that's PO's job after proper research and validation)
- Cannot set structured `targetFiles` frontmatter (PO does this with research-grounded paths)
- Cannot set `testRequirements` frontmatter (PO does this)

A proto-story is a sketch. It captures intent. PO formalizes it.

**Enforcement**: This is not just a convention — it's a code-level guard. See "Proto-story guard" in Current State Requirements Divergence below.

### Feed outputs downstream
When a design riff produces something worth formalizing:

- **"Formalize this research"** → Dispatcher launches Research Governor to ground the note in codebase research, add RAG-sourced file references, and embed it
- **"Turn this into a story"** → Dispatcher launches PO Governor with the riff's content as the task description. PO runs proper research, creates the story with full frontmatter, sets phase to ready
- **"Ship these docs"** → Dispatcher launches Ship Governor (ad-hoc path) to commit, push, PR, merge the accumulated notes

### Explore and question the system
Design riffs are where architectural questions get asked and answered:
- "Does the Dispatcher have a good reason to go guardrails off for research?"
- "Is scope the same thing as hook tier?"
- "Should QA re-run unit tests?"

The answers become documentation. The documentation becomes the spec.

## What You Cannot Do in a Design Riff

- **Write source code** — code stays protected. No `rks_exec`, no Edit/Write to source files
- **Finalize stories** — can sketch `backlog.feat.*` bodies but not set phase/targetFiles/testRequirements
- **Run builds** — no `rks_plan`, `rks_exec`. Those belong to the Build Governor
- **Ship automatically** — changes accumulate locally. Ship only on user request

## Namespace Rules

Design riff has the most flexible namespace rules of any session type:

| Namespace | Access | Notes |
|---|---|---|
| `how-to.*` | Read/Write | Operational docs |
| `design.*` | Read/Write | Architecture notes |
| `research.*` | Read/Write | Research findings |
| `notes.*` | Read/Write | General notes |
| `backlog.feat.*` | Read/Write body | Can draft bodies, cannot set phase/targetFiles/testRequirements |
| `backlog.fix.*` | Read only | QA owns this namespace |
| Custom namespaces | Create on the fly | For topics that don't fit existing ones |

## Shipping a Design Riff

Changes made during a design riff are local files. They're not committed, not pushed, not in any PR. They persist across the conversation but not across sessions (unless committed).

When the user is satisfied with the state of the docs:

1. User says "ship these docs" (or similar)
2. Dispatcher launches Ship Governor (ad-hoc path)
3. Ship commits all changed notes with a `docs(<scope>): <message>` commit
4. Push, PR, merge to staging

**Batch, don't stream**: A design riff may produce 10 edits across 5 notes. These ship as one commit, not 10. The user decides when the batch is ready — not the Dispatcher, not a Governor.

## RAG Embedding

Notes created during a design riff are NOT automatically embedded in RAG. They're local files until shipped. If a note needs to be searchable by future Research/PO queries before shipping:

- Call `rks_rag_embed` explicitly for that note
- This is rare during a riff — usually embedding happens after shipping, when the note is in its final form

## Provenance Model

| Who | Gets provenance? | How |
|-----|------------------|-----|
| Dispatcher | Yes | Open flow `rks_governor_init` creates a session. Dendron tool calls are authorized. |
| Research/PO (downstream) | Fresh session | If a riff feeds into a Governor, that Governor starts its own session with its own research. |

The design riff's provenance doesn't transfer to downstream Governors. Each Governor grounds itself independently.

## When to Use a Design Riff vs Research Governor

| Signal | Use Design Riff | Use Research Governor |
|---|---|---|
| User is actively collaborating | Yes | No |
| Need multiple iterations with feedback | Yes | No — Governor runs once and returns |
| Exploring open-ended questions | Yes | No |
| Need RAG-grounded, citable research | No | Yes |
| Need to embed findings for future PO/Build use | No — do it after shipping | Yes — Research embeds as part of its chain |
| Writing a focused research note on one topic | Maybe — if you want user review first | Yes — if the topic is clear enough for a single pass |

The heuristic: if the user is driving and wants to see/edit the output before it's final, it's a design riff. If the task is clear enough to delegate, it's a Research Governor.

## Current State Requirements Divergence

### NOT BUILT: `design_riff` session type in guardrails

**Severity: Medium — design riffs work today but aren't formally recognized**

Design riffs currently use a generic `guardrails_off` with `scope: 'write'` or `scope: 'read'`. There's no `sessionType: 'design_riff'` in the guardrails state. This means:
- No telemetry distinguishes design riffs from other off-rail sessions
- No hook behavior is tailored to riff mode (e.g., allowing doc writes while blocking code writes)
- Session audit logs don't capture the riff context

**Fix**: Add `sessionType` to the guardrails state file. When `sessionType: 'design_riff'`, hooks allow writes to `notes/` but block writes to source code. Telemetry tags the session for analysis.

### NOT BUILT: Proto-story guard (namespace + field guard)

**Severity: Medium — prompt-level enforcement only, real risk of accidental finalization**

Nothing prevents a design riff (or any non-PO session) from calling `dendron_update_field` to set `phase: 'ready'` on a `backlog.*` note. The constraint is prompt-level ("PO formalizes stories") not system-level.

**Fix (Option B — namespace + field guard)**: Add a narrow guard in the Dendron note handlers (`dendron_create_note`, `dendron_edit_note`, `dendron_update_field`). When writing to a `backlog.*` note, check the governor token's flow type:

- **PO / story flow** → full access to all frontmatter fields
- **Any other flow** (open, design_riff, research) → reject setting `phase: 'ready'`, `targetFiles`, and `testRequirements`

The guard is narrow: one namespace (`backlog.*`), three protected fields. Everything else passes through — design riffs can still write problem statements, rough ACs, solution sketches. Only PO can finalize a story.

This aligns with the broader access control pattern: flow-aware restrictions in MCP tool handlers rather than prompt-level conventions. See `how-to.agent-operations.backlog` for how this fits into the larger refactoring clusters.

### DESIGN: Riff-to-Governor handoff

**Severity: Low — works manually but could be smoother**

When a design riff produces something worth formalizing, the handoff is conversational: the user says "turn this into a story" and the Dispatcher launches PO. The PO Governor doesn't know about the riff — it starts fresh.

A smoother handoff might pass the riff's note content as context to the PO Governor, so PO doesn't need to re-research what the riff already explored. This is an optimization, not a blocker.