---
name: skills-rks-onboard
description: Run the rks onboarder — guided first-run tour through stories, permissions, cost, and first PR. Resumes from last completed stage if a session exists. Use when the user types /rks-onboard or asks to start onboarding.
user-invocable: true
disable-model-invocation: false
---

# rks Onboard Skill

Call `rks_onboarder` with `{ projectId: "routekit-shell" }` (replace with the current project's projectId from CLAUDE.md). The tool returns a `display` field — print it verbatim to the user. If the tool returns `prompts`, display them and wait for user input before calling `rks_onboarder` again with the `responses` field populated. Continue until the tool returns `stage: "next_steps"` and `state.completedStages` includes `"next_steps"`.

## Flags

- `/rks-onboard --skip-tour` → call with `{ projectId, skipTour: true }`
- `/rks-onboard --bounce` → call with `{ projectId, stage: "welcome", bounce: true }`
- `/rks-onboard --reset` → call with `{ projectId, reset: true }`
- `/rks-onboard --stage <stage>` → call with `{ projectId, stage: "<stage>" }`
