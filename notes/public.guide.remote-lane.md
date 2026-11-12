---
id: public.guide.remote-lane
title: Remote Lane Guide
desc: How a remote MCP client connects to rks through mcp-rks-http, and what the fixed remote lane admits.
created: 1794507637697
updated: 1794507637697
---

# Remote Lane Guide

The remote lane lets a remote MCP client (for example Grok, or any client that speaks MCP over HTTP) read a project's knowledge base and leave notes in an inbox, without being able to change code, run builds or ship.

## What the remote lane is

`remote` is one of the lanes rks knows (`ide`, `dispatch`, `call`, `mcp`, `remote`). A server started by `mcp-rks-http` pins `RKS_VIA=remote`. Unlike the other lanes, the remote lane's policy is fixed in code in `packages/mcp-rks/src/shared/lane-policy.mjs`. A `lanes.remote` entry in `.rks/project.json` is dropped with the warning "lanes.remote is ignored: the remote lane policy is fixed in code", so a project file can never widen it.

## Tools the remote lane admits

- `rks_governor_init` — open flow only; this is how a client obtains a token.
- `rks_governor_end`
- `rks_rag_query`
- `dendron_read_note` — any note.
- `dendron_create_note` — only under `inbox.<RKS_ACTOR>.` with a non-empty remainder.

Every tool except `rks_governor_init` requires the token as `_governorToken`.

## Inbox writes

A remote client writes only to `inbox.<RKS_ACTOR>.<name>`. The `inbox.` namespace is reserved and is not embedded into RAG, so remote notes are not embedded into the knowledge base.

## Owner setup of mcp-rks-http

1. Create a dedicated linked worktree of the project with `git worktree add`. The primary checkout is refused.
2. In that worktree's gitignored `.env`, set `RKS_REMOTE_BEARER=<your-bearer-secret>` (at least 32 characters). The bearer is read from that file only.
3. Start the server: `RKS_REMOTE_ROOT=<worktree> RKS_ACTOR=<actor> mcp-rks-http`.

Required environment: `RKS_REMOTE_ROOT` (the worktree) and `RKS_ACTOR` (lowercase letters, digits and hyphens).

Optional environment:

- `RKS_REMOTE_PORT` — port to bind (default 0, an ephemeral port that is logged).
- `RKS_REMOTE_HOST` — bind host; anything other than `127.0.0.1` is refused.
- `RKS_REMOTE_ALLOWED_HOSTS` — extra allowed Host header values, comma separated, e.g. `<your-tunnel-host>`.
- `RKS_REMOTE_MAX_SESSIONS` — concurrent session cap (default 8).
- `RKS_REMOTE_SESSION_IDLE_MS` — idle timeout before a session is evicted.
- `RKS_REMOTE_STREAM_MAX_MS` — maximum lifetime of a routed response.
- `RKS_REMOTE_SSE_HEARTBEAT_MS` — keepalive interval on an open SSE stream.
- `RKS_REMOTE_BOOT_INDEX` — unset builds the worktree RAG index at boot when absent; `skip` skips that step.

The server binds loopback only. To reach it from a remote client, put a tunnel in front of it and add the tunnel's host to `RKS_REMOTE_ALLOWED_HOSTS`.

## Refusals a client will see

- `remote_tool_not_allowed` — the tool is not on the list above, or `rks_governor_init` was not an open-flow init.
- `remote_token_required` — call `rks_governor_init` first and pass its token.
- `remote_project_mismatch` — the lane is pinned to the worktree's project id.
- `remote_project_unresolved` — the worktree's `.rks/project.json` carries no string id.
- `remote_actor_unset` — `RKS_ACTOR` is not set in the server environment.
- `remote_write_outside_prefix` — a create outside `inbox.<RKS_ACTOR>.`.
