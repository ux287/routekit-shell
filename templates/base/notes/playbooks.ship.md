---
id: "playbooks.ship"
title: "Ship Playbook"
desc: "Commit changes, create PR, merge"
created: 1771182729532
updated: 1771182729532
agents:
  - rks_agent_git
  - rks_agent_ship
phases:
  - name: stage
    agent: rks_agent_git
    description: "Check git state, stage changes"
    gate: null
    required: true
  - name: commit
    agent: rks_agent_git
    description: "Create commit with descriptive message"
    gate: approval
    required: true
  - name: pr
    agent: rks_agent_ship
    description: "Create pull request"
    gate: null
    required: true
  - name: merge
    agent: rks_agent_ship
    description: "Merge pull request"
    gate: approval
    required: true
audibles:
  - trigger: merge.conflict
    action: "Call rks_agent_git to check state, attempt rebase, retry merge once"
    maxRetries: 1
  - trigger: pr.ci_pending
    action: "Wait 30 seconds, re-check CI status, retry"
    maxRetries: 2
---

# Ship Playbook

Commit changes, create PR, merge. Used after develop playbook completes.

## Phase Details

### 1. stage

**Agent**: Git Agent (`rks_agent_git`)
**Entry**: Code changes ready to commit
**Exit**: Changes staged, git state reported

Check the current git state. Report what files are modified, added, or deleted. Stage the relevant changes.

### 2. commit

**Agent**: Git Agent (`rks_agent_git`)
**Entry**: Staged changes
**Exit**: Commit created
**Gate**: `approval` — present the staged changes and proposed commit message to the user

Create a commit with a clear, descriptive message. The user must approve before the commit is made.

### 3. pr

**Agent**: Ship Agent (`rks_agent_ship`)
**Entry**: Commit on branch
**Exit**: Pull request created

Create a pull request with a summary of the changes.

### 4. merge

**Agent**: Ship Agent (`rks_agent_ship`)
**Entry**: PR created, CI passing
**Exit**: PR merged
**Gate**: `approval` — user confirms merge

Merge the pull request. If there's a merge conflict, trigger the audible to attempt rebase.
