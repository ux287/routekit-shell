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

## Owner operations

`scripts/remote-lane.mjs` ties the owner's steps together (`npm run remote-lane -- <subcommand>` runs the same script). It wraps the existing `mcp-rks-http` server and its own boot checks; it does not change what the remote lane admits. Each step below names the subcommand and its manual equivalent.

1. **Setup.** From the project's primary checkout run `node scripts/remote-lane.mjs setup --root <worktree> --actor <actor>`. When `<worktree>` does not exist it runs `git worktree add` with a new branch `remote/<actor>` (`--branch <name>` picks another). When the worktree's `.env` has no `RKS_REMOTE_BEARER`, it appends a generated one of 64 characters. The bearer value is never printed. A second run changes nothing and says so, after reading the existing `.env`. Manual equivalent: `git worktree add -b remote/<actor> <worktree>`, then put `RKS_REMOTE_BEARER=<your-bearer-secret>` in `<worktree>/.env`.
2. **Check.** `node scripts/remote-lane.mjs check --root <worktree> --actor <actor>` runs the server's boot checks without starting it and prints `ok` or the refusal reason and message (for example `remote_root_primary_checkout` or `bearer_too_short`). With `--port <n>` it also probes a running server on 127.0.0.1 and reports the observed statuses: a request with no bearer must get 401, and a GET to `/mcp` with the bearer and no session must get 400. There is no health endpoint. Manual equivalent: start the server and read its refusal line.
3. **Start.** `node scripts/remote-lane.mjs start --root <worktree> --actor <actor> [--port <n>]` runs the check first and refuses, without starting anything, when it fails. Otherwise it runs `mcp-rks-http` with `RKS_REMOTE_ROOT`, `RKS_ACTOR` and, when given, `RKS_REMOTE_PORT`, and exits with the server's exit code. It never passes the bearer in the server's environment; the server reads it from `<worktree>/.env`. Wait for the `listening on` line, which names the bound port. Manual equivalent: `RKS_REMOTE_ROOT=<worktree> RKS_ACTOR=<actor> mcp-rks-http`.
4. **Tunnel.** The server binds 127.0.0.1 only. Point a tunnel at the logged port and add the tunnel's host to `RKS_REMOTE_ALLOWED_HOSTS` (for example `<your-tunnel-host>`) in the environment you start from. Give the remote client the tunnel address with path `/mcp` and the bearer as `Authorization: Bearer <your-bearer-secret>`.
5. **Inbox review.** `node scripts/remote-lane.mjs inbox --root <worktree> --actor <actor>` is read-only: it lists the `inbox.<actor>.*` notes committed at the tip of the worktree's branch (git `ls-tree`, no checkout) and prints the exact list, accept and discard calls of the owner-side inbox review tool with that branch filled in. Run those calls from an owner session in the primary checkout, never through the remote lane, which does not admit that tool. Accept copies a note into the configured working branch under a target name outside `inbox.`, and refuses unless that working branch is checked out and differs from the source branch. Discard only records the decision in the gitignored `.rks/state/inbox-decisions.json`. Manual equivalent: `git ls-tree -r --name-only remote/<actor> -- notes`.
6. **Refreshing the index.** The server builds the worktree's RAG index at boot only when there is none (an index under `<worktree>/.rks/rag` that is present is never refreshed at boot), and `RKS_REMOTE_BOOT_INDEX=skip` skips the step. To refresh it, stop the server, remove `<worktree>/.rks/rag`, and start again with `RKS_REMOTE_BOOT_INDEX` unset; the server logs `boot index: start` and `boot index: done` before it listens.
7. **Stopping.** Press Ctrl-C in the terminal running `start`, or send SIGTERM to the script or to the server. The server closes every session, logs its `shutdown` line and exits 0 when every close succeeded.
8. **Alias.** `node scripts/remote-lane.mjs alias` prints a suggested shell alias line with the script's absolute path. It writes no file; add the line to your shell profile yourself if you want it.

## Refusals a client will see

- `remote_tool_not_allowed` — the tool is not on the list above, or `rks_governor_init` was not an open-flow init.
- `remote_token_required` — call `rks_governor_init` first and pass its token.
- `remote_project_mismatch` — the lane is pinned to the worktree's project id.
- `remote_project_unresolved` — the worktree's `.rks/project.json` carries no string id.
- `remote_actor_unset` — `RKS_ACTOR` is not set in the server environment.
- `remote_write_outside_prefix` — a create outside `inbox.<RKS_ACTOR>.`.
