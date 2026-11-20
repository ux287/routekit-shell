---
name: skills-promote
description: |
  Promote staging to production (staging → main). Only invoke manually — never auto-triggered.
  Use when all CI checks pass and you're ready to merge staging into main.
disable-model-invocation: true
user-invocable: true
---

# Promote Skill

Merges staging into main. This is a manual-only operation — Claude will never invoke it autonomously.

## Preconditions

Before proceeding, verify ALL of the following:

1. Current branch is `staging`
2. `staging` is up to date with `origin/staging` (no unpushed commits)
3. All CI checks on staging are green
4. User has explicitly confirmed they want to promote

If any precondition fails, STOP and report which one failed. Do not proceed.

## Instructions

1. Confirm preconditions with the user
2. Run: `git checkout main && git merge staging --ff-only`
3. If fast-forward fails, STOP — do not force merge. Report the conflict.
4. Push: `git push origin main`
5. Switch back: `git checkout staging`
6. Report: commit SHA, branch state, success/failure
