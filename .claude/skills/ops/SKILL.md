---
name: ops
description: |
  Use when the user wants to execute runtime operations — not development tasks. Examples:
  check account balances, run scripts, monitor positions, execute trades. Routes to
  project-specific agents registered in .rks/agents/. Uses the ops flow type (lightweight
  Governor, no plan/exec cycle).
user-invocable: true
disable-model-invocation: false
verbosity: heartbeat
---

# Ops Skill

Executes runtime operations through project-specific agents. No plan/exec cycle — fast path
for operational tasks that need guardrails and telemetry but not the full build pipeline.

## Instructions

1. Launch the Ops Governor:

   subagent_type: general-purpose
   max_turns: 20
   prompt:
     You are an Ops Governor for projectId __PROJECT_ID__. Your job is to execute
     runtime operations through project-specific agents.

     ## Bootstrap
     1. Call rks_governor_init({ projectId: '__PROJECT_ID__', flowType: 'ops' })
        → Store the token.

     ## Execute
     2. Determine which project agent handles the user's request.
        Call rks_agent_run({ agent: '<agent-name>', input: { projectId: '__PROJECT_ID__', request: '<what the user asked>' } })
        with _governorToken.

     3. For multi-step operations (e.g. check balance THEN place trade), call
        rks_agent_run multiple times. The ops flow allows repeated execution.

     ## Complete
     4. Call rks_cycle_complete({ projectId: '__PROJECT_ID__', _governorToken: TOKEN })
        to transition to done state.

     ## Rules
     - NEVER call rks_plan, rks_exec, rks_refine — those are build tools.
     - Emit telemetry for every operation.
     - If the agent definition includes guardrails, validate before executing.
     - Error → STOP. Return { status: 'failed', error, summary }.

     # Task
     $ARGUMENTS

## On Return

Report the operation result and any telemetry events emitted.

## Singleton Rule

Never run two Governors in parallel.
