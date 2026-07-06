---
id: "how-to.0-agent-operations.research"
title: "2 Research"
desc: "How the Research Governor and its agents work — chain, provenance, RAG, namespaces"
updated: 1778535984883
created: 1772207163478
---

## Purpose

Ad-hoc research, design, and documentation. The Research Governor produces **notes as deliverables** — it never calls `rks_plan` or `rks_exec`.

Called by the Dispatcher when the user wants to design, research, or create documentation. The Dispatcher launches the Research Governor via `Task(subagent_type: \"general-purpose\")`.

## Governor Chain

```
0. rks_governor_init({ projectId }) → TOKEN
1. rks_agent_research({ projectId, query, _governorToken: TOKEN })
1b. (OPTIONAL) rks_agent_external_research({ projectId, query, _governorToken: TOKEN })
2. dendron_create_note({ projectId, filename, content, _governorToken: TOKEN })
3. rks_rag_embed({ projectId, files: ['notes/<filename>.md'] })
```

## What `rks_agent_research` Does Internally

- Runs **server-side** — Claude Code hooks do not apply
- Implementation: `packages/mcp-rks/src/agents/research.mjs` → `createResearchAgent()`
- Has two tools:
  - `rag_query` — searches LanceDB vector index (hybrid: semantic + keyword)
  - `read_file` — reads files after RAG identifies them (path traversal safety enforced)
- System prompt enforces: max 2 RAG queries, max 3 file reads
- **Provenance granting**: When RAG returns matches, `addRagSourcedPath(path, query)` writes to `.rks/session/state.json`. This grants read provenance to the Dispatcher and other agents — `hasValidProvenance(path)` checks session state for three provenance sources:
  - RAG-sourced paths (from research queries)
  - User-specified paths (from user messages)
  - Plan-context paths (from active plan targetFiles)

## What `rks_agent_external_research` Does Internally

- Searches the web via **Brave Search API** (`BRAVE_API_KEY` required)
- Implementation: `packages/mcp-rks/src/agents/external-research.mjs`
- Synthesizes results via Claude LLM (sonnet model)
- Returns `{ ok, answer, sources, telemetryId }`
- Does **NOT** embed results into RAG automatically
- Does **NOT** create notes automatically
- Emits telemetry: `agent.external-research.started/complete/failed`
- Provider system is extensible — `SEARCH_PROVIDERS` map currently has `brave` only

## RAG Embedding

- Step 3 explicitly calls `rks_rag_embed` — this is **unprotected** (no Governor token needed)
- Embeds the note into the LanceDB index so future research queries (by PO, Build, or other Governors) can discover it
- `dendron_create_note` also triggers a background embed via `writeNoteRaw()` → spawns `scripts/rag/embed.mjs` detached
- The explicit call in step 3 is the primary mechanism; the auto-embed is a safety net
- Embedding must emit telemetry so we know who, when, and why the embed occurred

## Allowed Namespaces

**Anything EXCEPT `backlog.*`.**

The `backlog` namespace is protected. The Research Governor can write to any other namespace: `research.*`, `design.*`, `notes.*`, `reports.*`, `how-to.*`, etc. This avoids artificially constraining child projects that may have their own namespace vocabulary.

> Code-level enforcement exists via `DENIED_NAMESPACES` guard in `packages/mcp-rks/src/agents/research.mjs`.

## Provenance Model

| Who | Gets provenance? | How |
|-----|------------------|-----|
| Research Governor | Yes | Its own `rks_agent_research` call populates session state |
| Dispatcher | Yes (indirect) | Session state persists after Governor returns; Dispatcher hooks check `hasValidProvenance()` |
| Other Governors (same session) | Yes (indirect) | Same session state mechanism — paths persist until next embed event |
| PO Governor | Separate session | PO calls its own `rks_governor_init` and `rks_agent_research`, gets its own provenance |

## Governor Token and State Machine

- Research operates in **open flow** (no problemId on governor_init)
- Allowed tools (OPEN_FLOW_TOOLS): `rks_agent_research`, `rks_agent_external_research`, `rks_agent_git`, `rks_agent_visual`, `dendron_create_note`, `dendron_edit_note`, `dendron_read_note`, `dendron_update_field`, `rks_preflight`
- Forbidden: `rks_refine`, `rks_plan`, `rks_exec` (those belong to Build)
- `rks_rag_embed` is unprotected — no token needed

## Bootstrapping

The Dispatcher launches the Research Governor as a `Task(subagent_type: \"general-purpose\")`. The Task subagent runs in Claude Code and IS subject to hooks. However, the Governor's chain is entirely MCP tools (`rks_governor_init`, `rks_agent_research`, `dendron_create_note`, etc.) which execute **server-side** and bypass hooks. The Governor prompt explicitly says \"Never use Claude Code tools\" — this is by design.

## Dispatcher Integration

Per CLAUDE.md, the Dispatcher:
1. Tells the Governor to read its own prompt at `.rks/prompts/governor-research.md`
2. Replaces `__PROJECT_ID__` with the project ID
3. Launches via `Task(subagent_type: \"general-purpose\", max_turns: 10)`

On return:
- `status: 'review'` → present summary and artifacts to user
- `status: 'failed'` → report error, suggest telemetry diagnostics

## Current State Requirements Divergence

### UX: Research Agent should be the natural first choice, not a redirect penalty

**Severity: High — core UX principle**

The hooks that redirect Read/Glob/Grep to the Research Agent (`redirect-read-to-agent.mjs`, `redirect-glob-to-agent.mjs`, `redirect-grep-to-agent.mjs`) are architecturally correct. The Dispatcher should not read files directly — it should go through Research. The redirect hooks enforce this by intercepting direct tool calls and pointing to the RA.

The problem is not the redirect — it's that the redirected path has too much friction:
- **Latency**: Research agent starts on haiku, which exceeds max turns 33% of the time, triggering escalation to sonnet. A query that should take 5s can take 30s.
- **Invocation complexity**: The Dispatcher has to think about Governor tokens, MCP tool names, and query formatting. Calling `rks_agent_research` should be as natural as calling `Read`.
- **Result fidelity**: Research returns synthesized summaries. Sometimes the Dispatcher needs \"show me line 47 of this file\" — raw content, not interpretation.

The ideal UX: the Dispatcher calls Read/Glob/Grep, the hook seamlessly redirects to the RA, and the result comes back as if it were a direct read. Early in a context window the Dispatcher might need the redirect; as the session progresses, calling the RA directly becomes automatic. If this could be enforced as a smooth, rideable rail from the start, guardrails stop feeling like guardrails.

**Fixes needed**:
- Reduce RA latency (increase haiku max turns, route complex queries to sonnet directly)
- Make invocation trivial (the hook redirect should handle token/format/routing transparently)
- Support raw file content mode (the RA's \"verbatim mode\" exists — surface it better)

### BUG: RAG embed emits zero telemetry

**Severity: Medium — no observability into embedding operations**

Telemetry query for `rag.embed` events returns 0 results. Neither `rks_rag_embed` (explicit call) nor the auto-embed from `writeNoteRaw()` produce telemetry events.

The auto-embed from `writeNoteRaw()` is fire-and-forget: spawns a detached process, ignores errors, no telemetry, no retry.

**Impact**: We cannot answer \"who embedded what, when, and why.\" If embedding silently fails, notes become invisible to future research queries with no diagnostic trail.

**Fix**: Add telemetry events to `rks_rag_embed` (`rag.embed.started`, `rag.embed.complete`, `rag.embed.failed`) and add at minimum error logging to the auto-embed in `writeNoteRaw()`.

### UX: Research agent escalation rate is high (33% today)

**Severity: Low — works correctly but adds invisible latency and cost**

Today's telemetry: 12 research invocations, 4 escalations (33%), 4 failures (33%). Yesterday: 30 invocations, 7 escalations (23%), 6 failures (20%).

The research agent starts on haiku, which frequently exceeds max turns (7), triggering automatic escalation to sonnet. Escalation is transparent to the caller but adds latency.

**Possible fixes**:
- Increase haiku max turns from 7 to 10
- Route complex queries (long query strings, multi-part questions) directly to sonnet
- Add retry guidance in error responses

### UX: Prompt files inaccessible with guardrails on

**Severity: Low — architectural question, not a blocking bug**

`.rks/prompts/*` files are not in the read-classification allowlist. The CLAUDE.md instruction \"Read `.rks/prompts/governor-*.md`\" is technically impossible with guardrails on. However, the bootstrapping model (Governor reads its own prompt via server-side MCP) makes this instruction unnecessary. CLAUDE.md should be updated to match the bootstrap pattern.

### BUG: GitHub MCP tools bypass all guardrails

**Severity: Critical — complete escape hatch around scope, workflow, and telemetry**

`mcp__github__create_or_update_file`, `mcp__github__push_files`, `mcp__github__merge_pull_request` are not intercepted by any hook and are not in any Governor tool allowlist. The Dispatcher (or a misbehaving Governor) can push arbitrary code changes directly to GitHub, bypassing scope validation, branch workflow, and telemetry.

**Fix**: Add GitHub write MCP tools to hook interception or Governor token enforcement so they require a valid token and respect flow state.

### UX: Telemetry query type filter requires exact subtype

**Severity: Low — discoverability issue**

Querying with `type: 'agent.research'` returns 0 results because event types use subtypes (`agent.research.started`, etc.). Prefix matching would improve usability.
