---
id: "playbooks.recovery"
title: "Recovery Playbook"
desc: "Diagnose and fix broken state"
created: 1771182729532
updated: 1771182729532
agents:
  - rks_agent_research
  - rks_agent_git
  - rks_agent_recovery
phases:
  - name: diagnose
    agent: rks_agent_research
    description: "Understand what is broken — git state, error logs, file state"
    gate: null
    required: true
  - name: fix
    agent: rks_agent_recovery
    description: "Apply the fix"
    gate: null
    required: true
  - name: verify
    agent: rks_agent_research
    description: "Confirm the fix worked"
    gate: null
    required: true
audibles:
  - trigger: fix.fails
    action: "Escalate to Dispatcher with full diagnosis"
    maxRetries: 0
---

# Recovery Playbook

Diagnose and fix broken state. Fast, no approval gates.

## Phase Details

### 1. diagnose

**Agent**: Research Agent (`rks_agent_research`) + Git Agent (`rks_agent_git`)
**Entry**: Something is broken
**Exit**: Understanding of what went wrong

Check git state, read error output, examine files. Build a diagnosis.

### 2. fix

**Agent**: Recovery Agent (`rks_agent_recovery`)
**Entry**: Diagnosis
**Exit**: Fix applied

Apply the fix. If the fix fails, escalate to the Dispatcher immediately — do not retry.

### 3. verify

**Agent**: Research Agent (`rks_agent_research`)
**Entry**: Fix applied
**Exit**: Confirmation that the fix worked

Verify the fix resolved the issue. Check git state, re-read files, confirm things are back to normal.
