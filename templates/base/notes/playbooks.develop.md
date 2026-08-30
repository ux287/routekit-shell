---
id: "playbooks.develop"
title: "Develop Playbook"
desc: "Plan and build features, fix bugs, write code"
created: 1771182729532
updated: 1771182729532
agents:
  - rks_agent_research
  - rks_agent_plan
  - rks_agent_delivery
phases:
  - name: research
    agent: rks_agent_research
    description: "Understand current project state, existing code, dependencies"
    gate: null
    required: true
  - name: plan
    agent: rks_agent_plan
    description: "Define what to build: target files, acceptance criteria, approach"
    gate: approval
    required: true
  - name: implement
    agent: rks_agent_delivery
    description: "Write the actual code — create files, edit files, generate components"
    gate: null
    required: true
  - name: verify
    agent: rks_agent_research
    description: "Confirm files were created/modified correctly, check for obvious issues"
    gate: null
    required: true
audibles:
  - trigger: implement.write_fails
    action: "Retry once with error context included in the agent request"
    maxRetries: 1
  - trigger: verify.issues_found
    action: "Return to implement phase with fix instructions from verify results"
    maxRetries: 1
---

# Develop Playbook

Plan and build features, fix bugs, write code. This is the primary playbook for all code-writing tasks.

## Phase Details

### 1. research

**Agent**: Research Agent (`rks_agent_research`)
**Entry**: User's feature request or bug description
**Exit**: Understanding of current project state

Explore the existing codebase: package.json, project structure, relevant source files, dependencies. Identify what exists and what needs to change.

### 2. plan

**Agent**: Plan Agent (`rks_agent_plan`)
**Entry**: Research findings + user's request
**Exit**: Development plan with target files and acceptance criteria
**Gate**: `approval` — present the plan to the user for sign-off before writing code

Create a plan: what files to create/modify, what the acceptance criteria are, what approach to take. The user must approve before implementation begins.

### 3. implement

**Agent**: Delivery Agent (`rks_agent_delivery`)
**Entry**: Approved plan
**Exit**: Code written

Write the actual code. Pass the full plan and research context to the Delivery Agent. It handles file creation, editing, and code generation.

### 4. verify

**Agent**: Research Agent (`rks_agent_research`)
**Entry**: Implementation complete
**Exit**: Verification that files exist and look correct

Check that the planned files were created/modified. Look for obvious issues (missing imports, syntax errors, incomplete implementations). If issues are found, trigger the audible to return to implement.
