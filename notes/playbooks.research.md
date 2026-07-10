---
id: playbooks.research
title: Research Playbook
desc: Read-only codebase exploration and information gathering
updated: 1771345015569
created: '1771182729532'
---

# Research Playbook

Read-only codebase exploration and information gathering. This is the simplest playbook — no mutations, no gates, no approvals needed.

## When to Use

- Answer questions about the codebase
- Explore architecture or implementation details
- Find files, patterns, or dependencies
- Gather context before planning work

## Phase Details

### 1. explore

**Agent:** `rks_agent_research`

Gather information based on the request. The Research Agent handles:
- RAG queries against the project knowledge graph
- File reads and content search
- Architecture and dependency exploration
- External research (when needed via `rks_agent_external_research`)

Entry criteria: A clear research question or exploration request from the Dispatcher.

Exit criteria: Sufficient information gathered to answer the question or provide the requested analysis.

### 2. report

**Agent:** none (Governor returns directly)

Return structured findings to the Dispatcher:
- Summarize discoveries
- Cite source files and line references
- Answer the original question
- Flag any areas that need further investigation

Entry criteria: explore phase complete with gathered information.

Exit criteria: Structured response returned to Dispatcher.

## Notes

- This playbook has no gates — research is always safe to run without approval.
- No files are modified during research.
- If research reveals work that needs to be done, the Governor should recommend the **develop** playbook as a follow-up.