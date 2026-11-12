---
id: backlog.feat.sample-feature
title: Sample backlog feature for release-smoke fixture
desc: A backlog note that the embed pipeline should classify as content_type 'backlog'. This is a fixture used by the release-smoke workflow — do not edit casually.
created: 1780972648343
updated: 1780972648343
phase: draft
status: open
problemType: feat
priority: medium
---

## Problem
The release-smoke fixture vault needs at least one backlog.feat.* note so embed produces a content_type='backlog' row.

## Vision
A backlog story with enough text to embed cleanly — the classifier (packages/cli/src/rag/classify.mjs as of v0.20.15) routes by filename prefix, so the body content here is mostly to give the embedder something to chunk.

## Notes
This fixture is checked into the repo at tests/integration/fixtures/release-smoke-vault/. If you change the content_type taxonomy, update tests/integration/release-smoke.test.mjs accordingly.
