---
id: hjlwphd0r8q3nct3ad1uw1f
title: Develop Playbook
desc: 'Plan and build features, fix bugs, write code'
updated: 1771344722632
created: '1771382400000'
agents: 'rks_agent_research, rks_agent_plan, rks_agent_delivery'
phases: 'research, plan, implement, verify'
audibles: 'implement.write_fails (retry once), verify.issues_found (retry once)'
---

# Develop Playbook

Plan and build features, fix bugs, write code. This is the core development playbook for child projects — it covers the full cycle from understanding the problem to verifying the solution.

## When to Use

- Build a new feature
- Fix a bug
- Refactor existing code
- Write new components, modules, or utilities
- Any task that requires creating or modifying source files

## Phase Details

### 1. research

**Agent:** `rks_agent_research`

Understand the current project state before making any changes:
- Read existing code in the target area
- Understand dependencies and imports
- Check for related patterns in the codebase
- Review any relevant documentation or story notes

Entry criteria: A development task from the Dispatcher describing what needs to be built or fixed.

Exit criteria: Sufficient understanding of the codebase to make a plan.

### 2. plan

**Agent:** `rks_agent_plan`

**Gate: approval** — The user must approve the plan before implementation begins.

Define what to build:
- List target files to create or modify
- Define acceptance criteria
- Describe the implementation approach
- Identify risks or dependencies

Entry criteria: Research phase complete with codebase understanding.

Exit criteria: Plan approved by user via the approval gate.

### 3. implement

**Agent:** `rks_agent_delivery`

Write the actual code:
- Create new files
- Edit existing files
- Generate components, modules, tests
- Follow the plan from the previous phase

Entry criteria: Approved plan from the plan phase.

Exit criteria: All planned files created or modified.

### 4. verify

**Agent:** `rks_agent_research`

Confirm the implementation is correct:
- Check that files were created/modified as planned
- Look for obvious issues (syntax errors, missing imports, broken references)
- Verify acceptance criteria are met

Entry criteria: Implementation complete.

Exit criteria: All checks pass, or issues identified for the implement audible.

## Audibles

| Trigger | Action | Retries |
|---------|--------|---------|
| `implement.write_fails` | Retry with error context | 1 |
| `verify.issues_found` | Return to implement with fix instructions | 1 |

## Notes

- The approval gate after **plan** is critical — never skip it. The user must see and approve what will be built.
- This playbook replaces the old **lifecycle** and **delivery** playbooks for child projects. Lifecycle was about story automation (not relevant for child project development). Delivery was about release pipelines (not about writing code).
- After develop completes, use the **ship** playbook to commit and create a PR.