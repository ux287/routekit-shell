---
id: "playbooks.research"
title: "Research Playbook"
desc: "Read-only codebase exploration and information gathering"
created: 1771182729532
updated: 1771182729532
agents:
  - rks_agent_research
phases:
  - name: explore
    agent: rks_agent_research
    description: "Gather information based on the request — files, code, dependencies, architecture"
    gate: null
    required: true
  - name: report
    agent: null
    description: "Return structured findings to the Dispatcher"
    gate: null
    required: true
audibles: []
---

# Research Playbook

Read-only codebase exploration and information gathering.

## Phase Details

### 1. explore

**Agent**: Research Agent (`rks_agent_research`)
**Entry**: User's question or exploration request
**Exit**: Information gathered

Call the Research Agent with the user's request. It will query RAG, read files, and search the codebase. Multiple calls are fine for broad exploration.

### 2. report

**Agent**: None (Governor formats the response)
**Entry**: Research results
**Exit**: Structured summary returned to Dispatcher

Format the findings and return to the Dispatcher. Include source file paths for provenance.
