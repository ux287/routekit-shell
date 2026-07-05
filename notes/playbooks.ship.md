---
id: playbooks.ship
title: Ship Playbook
desc: 'Commit, create PR, merge'
updated: 1771344765678
created: '1771182729532'
agents:
  - rks_agent_git
  - rks_agent_ship
  - rks_agent_cycle_complete
  - rks_agent_dendron
phases:
  - name: preflight
    agent: rks_agent_git
    description: 'Check git state, verify clean working tree, stage changes'
    gate: null
    required: true
  - name: ship
    agent: rks_agent_ship
    description: 'Branch, commit, create PR, merge, staging sync'
    gate: null
    required: true
  - name: complete
    agent: rks_agent_cycle_complete
    description: 'Mark implemented, run governance, embed RAG'
    gate: null
    required: false
audibles:
  - trigger: ship.merge_conflict
    action: 'Call Git Agent to check state, attempt rebase, retry'
    maxRetries: 1
  - trigger: ship.ci_pending
    action: 'Wait 30 seconds, re-check CI status, retry merge'
    maxRetries: 2
---

# Ship Playbook

Commit, create PR, merge. This playbook handles the full shipping workflow from staging changes through to a merged pull request.

## When to Use

- Commit and push completed work
- Create a pull request
- Merge changes to the target branch
- Any git shipping workflow

## Phase Details

### 1. stage

**Agent:** `rks_agent_git`

Check git state and stage changes:
- Run git status to see what has changed
- Review the diff of staged and unstaged changes
- Stage the appropriate files for commit
- Present the staged changes summary

Entry criteria: Work is complete and ready to be committed (typically after the **develop** playbook).

Exit criteria: Changes are staged and ready for commit.

### 2. commit

**Agent:** `rks_agent_git`

**Gate: approval** — The user must approve what will be committed before the commit is created.

Create the commit:
- Write a descriptive commit message summarizing the changes
- Create the commit
- Push to the remote branch

Entry criteria: Changes staged, user has approved the commit.

Exit criteria: Commit created and pushed.

### 3. pr

**Agent:** `rks_agent_ship`

Create a pull request:
- Generate PR title and description from the commit(s)
- Create the PR on the remote
- Link any relevant issues or stories

Entry criteria: Commit pushed to remote branch.

Exit criteria: PR created and URL returned.

### 4. merge

**Agent:** `rks_agent_ship`

Merge the pull request:
- Check that CI passes (if applicable)
- Merge the PR to the target branch
- Clean up the feature branch if appropriate

Entry criteria: PR created, CI passing.

Exit criteria: PR merged successfully.

## Audibles

| Trigger | Action | Retries |
|---------|--------|---------|
| `merge.conflict` | Call Git Agent to check state, attempt rebase, retry | 1 |

## Notes

- The approval gate before **commit** ensures the user sees exactly what will be committed.
- This playbook does NOT include cycle-complete or story-marking steps — those belong to the rks self-development workflow, not child project shipping.
- If the merge fails due to conflicts after the retry, escalate to the Dispatcher.