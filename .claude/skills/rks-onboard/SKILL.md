---
name: skills-rks-onboard
description: Run the rks onboarder — guided first-run tour through stories, permissions, cost, and first PR. Resumes from last completed stage if a session exists. Use when the user types /rks-onboard or asks to start onboarding.
user-invocable: true
disable-model-invocation: false
---

# rks Onboard Skill

Call `rks_onboarder` with `{ projectId: "routekit-shell" }` (replace with the current project's projectId from CLAUDE.md). The tool returns a `display` field — print it verbatim to the user. If the tool returns `prompts`, display them and wait for user input before calling `rks_onboarder` again with the `responses` field populated. Continue until the tool returns `stage: "next_steps"` and `state.completedStages` includes `"next_steps"`.

If the projectId above is still an unsubstituted template token, resolve it from the projectId declared at the top of `CLAUDE.md`.

## Credential step

The welcome `display` asks which credential this machine has: an API key, a Claude subscription (claude.ai login), or neither. Relay that question to the user as shown in the `display`, then call `rks_onboarder` again with `responses.credentialChoice` set to `api`, `subscription` or `neither` (map the user's words onto one of the three). The tool resolves the credential server-side and returns the result in `display`; print it verbatim.

- When the `display` for `subscription` lists writes and asks for consent, pass `responses.credentialConsent: "yes"` together with `credentialChoice: "subscription"` only after the user explicitly agrees to those listed writes. Without an explicit yes, do not pass `credentialConsent`; a no, or no answer, means no consent.
- The Dispatcher never writes `.env` or `.rks/agents.yaml` itself: the `rks_onboarder` tool performs the consented writes and reports each one from a read-back. If the `display` gives lines for the user to add by hand, relay them; do not apply them yourself.
- The opt-in never goes in `.rks/project.json`, and this skill never edits that file.
- Do not write `ROUTEKIT_LLM_MODEL`; model choice is the user's. Relay the caveat if the `display` shows one.
- When the tour later reports that it is not dispatching a Governor because a flow is blocked, relay the blocker; do not launch that Governor anyway.

## Flags

- `/rks-onboard --skip-tour` → call with `{ projectId, skipTour: true }`
- `/rks-onboard --bounce` → call with `{ projectId, stage: "welcome", bounce: true }`
- `/rks-onboard --reset` → call with `{ projectId, reset: true }`
- `/rks-onboard --stage <stage>` → call with `{ projectId, stage: "<stage>" }`
