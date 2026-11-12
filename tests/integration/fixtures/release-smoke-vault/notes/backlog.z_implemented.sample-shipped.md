---
id: backlog.z_implemented.sample-shipped
title: Sample shipped backlog item for release-smoke fixture
desc: A previously-shipped backlog note that should classify as content_type='implemented'. This is the critical row — a release that produces zero implemented rows almost certainly has a classifier regression.
created: 1780972648343
updated: 1780972648343
phase: released
status: closed
problemType: feat
priority: medium
releasedIn: 0.0.1
---

## Problem
The release-smoke fixture vault needs at least one note that classifies as implemented so the smoke can assert content_type='implemented' is non-empty.

## Vision
The classifier (post-v0.20.15) routes any backlog.z_implemented.* filename OR any note under notes/z_implemented/ to content_type='implemented'. This file exercises the filename-prefix path.

## What shipped
The implemented bucket is the canonical "ships are happening" signal — a release smoke that doesn't verify it is missing the point.
