---
id: la7d2cq79u5g2tifss7ux0m
title: Recovery Playbook
desc: 'Diagnose and repair broken state: git, locks, hooks, RAG'
updated: 1771344776828
created: '1771182729532'
agents:
  - rks_agent_research
  - rks_agent_git
  - rks_agent_recovery
phases:
  - name: diagnose
    agent: null
    description: >-
      Assess the broken state using raw tools — git status, file reads, log
      analysis
    gate: null
    required: true
  - name: triage
    agent: rks_agent_research
    description: 'Analyze diagnosis results, determine severity and fix strategy'
    gate: approval
    required: true
  - name: repair
    agent: null
    description: 'Apply the fix using raw tools — git operations, file edits, state cleanup'
    gate: null
    required: true
  - name: verify
    agent: rks_agent_git
    description: 'Confirm the fix worked — re-check state, verify project health'
    gate: null
    required: true
audibles:
  - trigger: diagnose.no_root_cause
    action: Escalate to Dispatcher — unable to determine root cause
    maxRetries: 0
  - trigger: repair.fails
    action: Escalate to Dispatcher with diagnosis — do not retry
    maxRetries: 0
  - trigger: verify.still_broken
    action: Escalate to Dispatcher — fix did not resolve the issue
    maxRetries: 0
---

# Recovery Playbook

Diagnose and fix broken state. This playbook is for when something has gone wrong — git conflicts, broken hooks, corrupted state, failed operations.

## When to Use

- Git is in a broken state (merge conflicts, detached HEAD, dirty working tree)
- Hooks or tools are failing unexpectedly
- A previous operation left things in a bad state
- Any "something is wrong" situation

## Phase Details

### 1. diagnose

**Agent:** `rks_agent_research` + `rks_agent_git`

Understand what is broken:
- Check git status and branch state
- Look for error messages or logs
- Examine file state for corruption or inconsistency
- Identify the root cause

Entry criteria: Something is broken or an error was reported.

Exit criteria: Clear diagnosis of what is wrong and what needs to be fixed.

### 2. fix

**Agent:** `rks_agent_recovery`

Apply the fix:
- Execute the repair based on the diagnosis
- Use the appropriate recovery strategy (git reset, conflict resolution, state cleanup, etc.)
- Be conservative — prefer safe operations over aggressive ones

Entry criteria: Diagnosis complete with a clear fix strategy.

Exit criteria: Fix applied.

### 3. verify

**Agent:** `rks_agent_research`

Confirm the fix worked:
- Re-check the state that was originally broken
- Verify the project is in a healthy state
- Confirm no new issues were introduced

Entry criteria: Fix applied.

Exit criteria: Project state verified as healthy.

## Audibles

| Trigger | Action | Retries |
|---------|--------|---------|
| `fix.fails` | Escalate to Dispatcher with diagnosis | 0 |

## Notes

- This playbook has **no gates** — recovery should be fast and not blocked by approvals.
- If the fix fails, do NOT retry — escalate immediately. Failed recovery attempts can make things worse.
- The diagnose phase should use both `rks_agent_research` (for file/code state) and `rks_agent_git` (for git-specific state).