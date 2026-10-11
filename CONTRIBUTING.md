# Contributing to RouteKit Shell

Thank you for considering a contribution.

## You must sign the CLA before your contribution can be accepted

rks is **dual-licensed**: it is released to everyone under the **GNU AGPL-3.0-or-later**, and it is also offered under a separate **commercial licence** to teams that cannot accept the AGPL's network-copyleft terms.

That dual-licence model only works if the maintainer holds the rights to relicense every line in the repository. A contribution the maintainer cannot relicense would have to be removed. That is why a signed [Contributor License Agreement](CLA.md) is required **before any contribution is accepted**.

The CLA does **not** transfer your copyright. You keep it. You grant the maintainer a licence.

> **The CLA has not been reviewed by a lawyer.** It is drafted for review by counsel. Nothing in this repository is legal advice.

### How to sign

1. Open your pull request.
2. The automated CLA check will comment on the pull request with signing instructions.
3. If the automated check is unavailable, use the manual fallback: complete the execution block at the end of [CLA.md](CLA.md) and post it as a comment on your pull request, stating that you have read and agree to the CLA. A maintainer will record it.

## How your contribution actually lands

`github.com/ux287/routekit-shell` is a **published mirror**, not the development repository. Every release replaces its `main` with a fresh single-commit snapshot of the upstream source, so a pull request cannot be merged here — a merge commit created on the mirror would be overwritten by the next release.

Opening a pull request is still the right way to propose a change: it carries the diff, it runs CI, and it is what gets reviewed. When a change is accepted, the maintainer applies it upstream and it reaches the mirror in the next release. **GitHub will then show your pull request as closed rather than merged.** That is not a rejection — it is the only outcome this mirror can produce.

Because each release is a single snapshot commit, git authorship does not survive publication. Accepted contributors are credited in [NOTICE](NOTICE) instead.

## The contribution path for outside contributors

1. **Fork** `github.com/ux287/routekit-shell`.
2. **Branch** from `main` — one branch per logical change.
3. **Make the change.** Keep it focused; unrelated changes belong in separate pull requests.
4. **Run the test suite** before opening the pull request.
5. **Open a pull request** against `main`. Describe what changed and why.
6. **Sign the CLA** (above) if you have not already.

## This is not the internal loop

The `## Contributing` section of the README describes the **internal dogfood loop** (`/po → /qa → /build → /ship → /release`) that the maintainer uses to develop rks with rks. That loop requires the private development repository and is **not** a contribution path for outside contributors. If you are contributing from a fork, this document is the path — not that one.

## Licence of your contribution

Your contribution is released under the AGPL-3.0-or-later along with the rest of the project, and — under the terms of the CLA — may also be offered by the maintainer under the commercial licence.
