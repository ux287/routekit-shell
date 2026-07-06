---
id: canon.sample-canon
title: Sample canon note for release-smoke fixture
desc: A canon-prefix note for content_type='note' diversity.
created: 1780972648343
updated: 1780972648343
---

## Purpose
Canon notes document the current contract of the system. The fixture vault uses this stub to ensure the embed pipeline does not silently drop canon-prefixed notes.

## Contract
A canon note must classify as content_type='note' (same bucket as research/how-to). If a future change splits canon into its own content_type, update tests/integration/release-smoke.test.mjs to assert the new type.
