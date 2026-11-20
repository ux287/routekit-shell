// Done-in-code pass, batch 3 onward (chore.backlog-done-in-code-remaining-namespaces).
// Ids are held stripped of the leading prefix and rebuilt at run time, so this file never
// contains a live note's full id (the sweep's test_reference guard reads test files).
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { destinationFor } from "../../scripts/backlog-archive-sweep.mjs";
import { parseFrontmatter } from "../../packages/mcp-rks/src/shared/frontmatter.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const NOTES = path.join(REPO_ROOT, "notes");
const MD = ".md";
const P = "backlog" + ".";
const full = (stripped) => P + stripped;
const STORY = "chore.backlog-done-in-code-remaining-namespaces";
const PREDECESSOR = "chore.backlog-agents-architecture-done-in-code";
const PAPER = path.join(NOTES, "research.2026.11.15.backlog-done-in-code-pass" + MD);

// Build-time candidate set (Solution section 1), keyed by batch number (3 onward). Each value is
// the list of stripped ids that batch examined, taken from that batch's --cutoff 2026-10-03 dry run.
const REMAINING = {
  // Batch 3 (feat): every live feat note the --cutoff 2026-10-03 dry run moved in cohort S
  // (no shelve[] entry, no earlier paper row), measured at @32ed2cfe1.
  3: [
    "feat.03-decompose",
    "feat.agent-definition-schema",
    "feat.agent-discovery",
    "feat.agent-schema-validation-retry",
    "feat.ape-with-pr",
    "feat.app-web-react-spa-template",
    "feat.approve-telemetry",
    "feat.arch-governor-adversarial-review",
    "feat.arch-needs-revision-amend-path",
    "feat.backlog-templates-initial-story-content",
    "feat.batch-feedback-queue-mode",
    "feat.block-git-off-rail-test-fix",
    "feat.block-planning-decomposed-stories",
    "feat.blog-dispatcher-skill",
    "feat.build-governor-semantic-slugs",
    "feat.child-project-controller",
    "feat.ci-poll-core.tests",
    "feat.ci-poll-wire",
    "feat.common-tools-guardrails-off-invariant-reconciliation",
    "feat.concern-governed-decompose-split",
    "feat.content-namespace-and-publish-workflow",
    "feat.context-health-tool",
    "feat.create-auto-analyze-module",
    "feat.create-auto-phase-module",
    "feat.cycle-complete-telemetry",
    "feat.dashboard-dev-port-1337",
    "feat.dashboard-local-timezone",
    "feat.dashboard-per-project-cost-breakdown",
    "feat.decomp-naming.independent-value-gate",
    "feat.decomp-naming.semantic-child-ids",
    "feat.decomp-naming.test-coverage-per-child",
    "feat.decompose-and-gate",
    "feat.decompose-signal-fix",
    "feat.decompose-trigger-concern-scoring",
    "feat.dendron-edit-note-empty-body-guard",
    "feat.dendron-edit-note-frontmatter-patches",
    "feat.dendron-edit-note-patches",
    "feat.dendron-namespace-guards",
    "feat.design-through-docs-research-surface",
    "feat.dispatcher-named-note-read-fast-path",
    "feat.dispatcher-pre-build-research-check",
    "feat.enforce-single-vitest-run",
    "feat.example-calculator-app",
    "feat.example-github-issue-to-pr",
    "feat.exec-auto-commit-notes-pre-check.child-1.child-2",
    "feat.exec-auto-commit-notes-pre-check.child-2",
    "feat.exec-auto-embed-on-success",
    "feat.exec-build-failure-enforcement",
    "feat.exec-no-actions-state-rollback",
    "feat.exec-only-guardrails-off",
    "feat.exec-preflight-exclude-all-notes",
    "feat.exec-step-divergence.child-2",
    "feat.exec-test-verification-report.child-2",
    "feat.exec-tests-failed-log-path",
    "feat.executed-story-small-amend-path",
    "feat.exhaustive-search-context-lines",
    "feat.external-document-ingestion",
    "feat.feat.cwd-auto-discovery-resolve-project-root",
    "feat.feat.project-rename-sync-command",
    "feat.fetch-allowlist-tool",
    "feat.fetch-raw-dynamic-provenance-allow",
    "feat.fetch-raw-output-control",
    "feat.fix-auto-phase-ship-transition",
    "feat.fix-ci-hooks-fallback-and-sed-bug",
    "feat.fix-fenced-search-replace-extraction",
    "feat.fix-intermittent-test-timeouts-cycle-stale",
    "feat.fix-off-rail-mark-implemented",
    "feat.fix-remaining-baseline-test-failures",
    "feat.fix-story-ship-dirty-tree",
    "feat.fix-test-suite-timeout-mocks",
    "feat.gh-release-create",
    "feat.git-agent-full-diff-option",
    "feat.git-agent-prose-fallback",
    "feat.git-provenance-tools",
    "feat.global-telemetry-mock.cleanup",
    "feat.global-telemetry-mock.infra",
    "feat.gov-release-check",
    "feat.governor-brief-disposition-receipt",
    "feat.governor-decompose-handler",
    "feat.governor-playbook-discipline",
    "feat.guardrails-off-child-agent-guidance",
    "feat.guardrails-off.selective-hook-retention",
    "feat.guardrails-off.tier-inference",
    "feat.guardrails-on-three-branch-aware",
    "feat.guardrails-physical-hooks-move",
    "feat.guardrails-state-file",
    "feat.honest-status-under-partial-failure",
    "feat.hook-router-telemetry",
    "feat.hooks-tier-migration-compat",
    "feat.how-to-child-project-kickoff-update",
    "feat.integrate-git-mcp",
    "feat.integrate-github-mcp",
    "feat.interview-relax-description",
    "feat.interview-skip-configured-steps",
    "feat.kg-dev-server-config",
    "feat.mark-implememented-update",
    "feat.markdown-format-rules-in-lint",
    "feat.marketing-site-callout-give-us-a-call",
    "feat.marketing-site-ci-tier",
    "feat.mcp-tool-audit-trail",
    "feat.memory-dated-namespace",
    "feat.modular-workflow-hooks",
    "feat.off-rail-git-detector-recovery-safe",
    "feat.off-rail-operations-telemetry",
    "feat.off-rail-read-provenance-telemetry",
    "feat.off-rail-ux.research-agent-self-bootstrap",
    "feat.off-rail-ux.scoped-tool-passthrough",
    "feat.off-rail-ux.session-idle-warning",
    "feat.off-rail-ux.session-tool-telemetry",
    "feat.offrail-config-tooling-write-scope",
    "feat.on-rail-build-for-non-core-marketing-work",
    "feat.openclaw-mobile-bridge",
    "feat.ops-skill-routing",
    "feat.parse-targets-strip-em-dash-suffix",
    "feat.per-path-test-commands-multi-stack",
    "feat.plan-preflight-inline",
    "feat.plan-quality-create-file-hard-block",
    "feat.plan-quality-overlapping-edits",
    "feat.plan-ready-companion-testfiles-gate",
    "feat.plan-ready-snippet-bypass",
    "feat.plan-review-reject-note-only-plans",
    "feat.planner-context-create-exists-liveread",
    "feat.planner-create-file-steps",
    "feat.planner-create-file-support",
    "feat.planner-filter-create-file-on-edit-targets",
    "feat.planner-fix-invalid-refinement-hint",
    "feat.planner-multiline-search-anchor",
    "feat.planner-note-pruning",
    "feat.planner-op-edit-search-block-guard",
    "feat.planner-op-mismatch-assertion",
    "feat.planner-overwrite-existing-fallback-op",
    "feat.planner-reviewer-create-file-supplement",
    "feat.planner-search-block-early-exit",
    "feat.planner-target-synthesis-rule",
    "feat.planner-targetfiles-context",
    "feat.planner-truncation-detection",
    "feat.playbook-scoped-tool-calls",
    "feat.po-clarify-high-consequence-structural-ambiguity",
    "feat.po-governor-completeness-gate",
    "feat.post-compact-recovery-hook",
    "feat.post-publish-mirror-ci-verification",
    "feat.preflight-return-rks-version",
    "feat.preflight-rks-version",
    "feat.preflight-shell-and-credential-provenance",
    "feat.process-cleanup-guards",
    "feat.project-context-cache-stale",
    "feat.project-rename-sync-command",
    "feat.prompt-schema-contract-guard",
    "feat.provenance-based-read-enforcement",
    "feat.provenance-spectrum-by-artifact-class",
    "feat.prune-preserve-search-blocks",
    "feat.publish-profile-drift-guard",
    "feat.python-anchor-extraction",
    "feat.qa-pipeline-decomposer-cleanup",
    "feat.qa-pipeline-simplify-po",
    "feat.qa-pipeline-state-machine",
    "feat.qa-pipeline-story-review",
    "feat.qa-requirements-to-scaffold-coverage-gate",
    "feat.rag-content-type-tagging.child-1",
    "feat.rag-content-type-tagging.child-3",
    "feat.rag-embed-manifest-walker-provenance",
    "feat.rag-embed-save-manifest",
    "feat.rag-query-intent-weighting",
    "feat.rag-reindex-after-classifier-fix",
    "feat.rag-reserved-namespaces-project-configurable",
    "feat.refine-acknowledge-multi-file",
    "feat.refine-add-search-pattern-caller-anchors",
    "feat.refine-child-decomp-1signal-fix",
    "feat.refine-child-decomp-human-gate",
    "feat.refine-create-exists-signal",
    "feat.refine-decompose-child-guard",
    "feat.refine-decompose-threshold-edit-only",
    "feat.refine-dedup-history-lines",
    "feat.refine-dedup-search-anchors",
    "feat.refine-disk-fetch-context",
    "feat.refine-note-only-policy",
    "feat.refine-note-size-cap",
    "feat.refine-numeric-assertion-patch",
    "feat.refine-projectid-telemetry-leak",
    "feat.refine-size-cap-search-gate",
    "feat.refine-test-exemplar-fallback-template",
    "feat.refine-test-exemplar-injection",
    "feat.refine-test-failed-log-analysis",
    "feat.refine-trigger-plan-rejected",
    "feat.regression-witness-scan-test-infra-detection",
    "feat.release-ff-fail-rollback",
    "feat.release-harden.publish-outcome-surfacing",
    "feat.release-harden.release-runbook-and-topology-docs",
    "feat.release-push-staging-fixes.child-2",
    "feat.release-staging-push-fail-handling",
    "feat.release-tag-after-merge",
    "feat.remove-stale-planproblem-removal-test",
    "feat.research-agent-child-project-reads",
    "feat.research-agent-exhaustive-search.ledger-stamped-absence-flag",
    "feat.research-agent-expand-write-namespaces",
    "feat.research-agent-write-access",
    "feat.research-agent-write-output",
    "feat.reviewer-skip-identity-transforms",
    "feat.rks-cli-status-init-verbs",
    "feat.rks-how-to",
    "feat.rks-onboarder-design",
    "feat.rks-onboarder-impl-phase1",
    "feat.rks-onboarder-impl-phase2",
    "feat.rks-onboarder-impl-phase3",
    "feat.rks-onboarder-impl-phase4",
    "feat.rks-onboarder-impl-phase5",
    "feat.rks-onboarder-implementation",
    "feat.route-git-during-off-rail",
    "feat.selective-guardrails-scope",
    "feat.setup-restart-claude-code-instruction",
    "feat.shell-install-inventory",
    "feat.ship-missing-staging-branch",
    "feat.spawn-managed-parent-exit-reaper",
    "feat.startup-banner",
    "feat.story-creation-validation",
    "feat.story-ship-review-block-acknowledgement",
    "feat.tag-branch-guard",
    "feat.telemetry-agent-runner",
    "feat.telemetry-bash-escape-capture",
    "feat.telemetry-history-archival",
    "feat.telemetry-infra-enrichment",
    "feat.telemetry-lifecycle-gaps",
    "feat.telemetry-model-selection-and-failure-class",
    "feat.telemetry-planner-lifecycle",
    "feat.telemetry-planner-snippets",
    "feat.telemetry-rag",
    "feat.telemetry-rag-embed-analysis",
    "feat.telemetry-recency-and-normalization.child-1",
    "feat.telemetry-recency-and-normalization.child-2",
    "feat.telemetry-recency-and-normalization.child-3",
    "feat.telemetry-refine-lifecycle",
    "feat.telemetry-release-complete",
    "feat.telemetry-report-granularity-and-timeline",
    "feat.test-assertion-enrichment",
    "feat.test-quality-exec-static",
    "feat.test-quality-qa-agent",
    "feat.test-quality-tdd-planning",
    "feat.three-branch-local-merge-telemetry",
    "feat.token-cost-report-per-project-scope",
    "feat.user-authority-attestation-stub",
    "feat.vendor-script-auto-commit.child-2",
    "feat.vendor-skills-auto-commit",
    "feat.visual-agent-core",
    "feat.web-vite-rag-agency-ships-test-toolchain",
    "feat.wire-mcp-contract-spec-ci-tier",
  ],
  // Batch 4 (fix): every live fix note the --cutoff 2026-10-03 dry run moved in cohort S
  // (no shelve[] entry, no earlier paper row), measured at @c85c2ef3e.
  4: [
    "fix.add-missing-git-mcp-tools",
    "fix.agent-dendron-blocked",
    "fix.agent-output-redaction-rewrites-env-lookups",
    "fix.agent-prompt-path-public-prefix",
    "fix.applycreatefile-silently-overwrites-existing-path",
    "fix.arch-flow-dendron-update-field-chain-violation",
    "fix.arch-verdict-gate-remaining-plan-ready-checks",
    "fix.auto-decompose-on-scope.child-2",
    "fix.auto-route-unknown-projectid",
    "fix.base-template-complete-skeleton",
    "fix.branch-config-missing-projectjson",
    "fix.build-commit-notes-on-failure",
    "fix.build-governor-testgen-fragility",
    "fix.build-governor-use-dendron-for-story-edits",
    "fix.build-prompt-anchor-discovery-route-unstated",
    "fix.build-prompt-refine-noop-state-claim",
    "fix.chain-violation-emit-underreport-check",
    "fix.chain-violation-recovery-text-unactionable",
    "fix.child-project-mcp-config-audit",
    "fix.ci-isolation-global-telemetry-mock",
    "fix.ci-phases-rename-cleanup",
    "fix.complete-tool-registration-validation",
    "fix.create-heading-fence-after-prose-refused",
    "fix.create-path-utils-module",
    "fix.decomposed-parent-implemented-transition",
    "fix.dendron-create-note-content-duplication",
    "fix.dendron-edit-existing-notes",
    "fix.dendron-edit-note-empty-body-unanchorable",
    "fix.dendron-edit-note-preserves-frontmatter",
    "fix.dendron-filename-rejects-notes-path-form",
    "fix.dendron-parser-quoted-scalar-slug-corruption",
    "fix.dendron-read-note-autoroute-no-direct-handler",
    "fix.dendron-read-untracked",
    "fix.dendron-update-field-rejects-body",
    "fix.dendron-update-field-yaml-arrays",
    "fix.dendron-write-atomicity",
    "fix.dirty-tree-comprehensive",
    "fix.dirty-tree-unified-check",
    "fix.dispatcher-tooling-blocked-under-guardrails-on",
    "fix.doctor-detects-stale-mcp-env-root",
    "fix.duplicate-frontmatter-on-story-creation",
    "fix.enforce-feature-branch-workflow",
    "fix.escalation-skip-non-model-faults",
    "fix.exec-abort-stranded-disambiguation-unreachable",
    "fix.exec-abort-unauthorized",
    "fix.exec-auto-cleanup-orphaned-branches",
    "fix.exec-auto-embed-reset-modules",
    "fix.exec-dirty-note-blocks-build",
    "fix.exec-failure-recovery-enforcement",
    "fix.exec-incomplete-previous-story-refusal-strands-executing",
    "fix.exec-pr-creation-gap",
    "fix.exec-result-contract-autocommit-dryrun",
    "fix.exec-resume-from-incomplete-record",
    "fix.executed-state-partial-ship-recovery",
    "fix.exhaustive-search-result-provenance",
    "fix.exhaustive-search-unreachable-for-arch-qa-governor",
    "fix.external-research-robustness",
    "fix.fresh-child-test-exemplar-poisoned",
    "fix.frontmatter-handling",
    "fix.git-agent-operation-fidelity",
    "fix.git-agent-routing-dead-end",
    "fix.git-merge-mark-implemented",
    "fix.git-preflight-skill.preflight-tool",
    "fix.git-preflight-skill.skill-md",
    "fix.git-preflight-skill.tests",
    "fix.git-preflight-skill.wire-ship",
    "fix.git-release-integration-extract",
    "fix.git-release-rollback-reset-repo-binding",
    "fix.git-state-deletion-sync",
    "fix.gitignore-tmp-class-leak",
    "fix.governor-build-manual-search",
    "fix.governor-toolset-lacks-rks-stash",
    "fix.governor-toolset-lacks-telemetry",
    "fix.guardrail-critical-approval-diff-blind-to-edits",
    "fix.guardrail-critical-approval-self-approvable",
    "fix.guardrails-audit-silent-clean-tree",
    "fix.guardrails-audit-tests-state-file",
    "fix.guardrails-auto-cleanup-tier-fixture",
    "fix.guardrails-off-require-problemid",
    "fix.guardrails-off-ships-deployed-hooks-drift",
    "fix.guardrails-off-staging-push",
    "fix.guardrails-off-stale-state",
    "fix.guardrails-paper-audit-restore",
    "fix.guardrails-scoped-writes-test-failures",
    "fix.guardrails-test-architecture",
    "fix.guardrails-test-use-injection",
    "fix.hook-env-var-consistency",
    "fix.hook-forcefulness-options",
    "fix.hooks-manifest-staleness.child-2",
    "fix.hooks-state-preflight",
    "fix.import-declaration-check-false-positives",
    "fix.inapplicable-status-unwitnessed-criteria",
    "fix.init-registration-gap",
    "fix.init-telemetry",
    "fix.mcp-enforcement-parity",
    "fix.mcp-json-portable-across-account-moves",
    "fix.mcp-tool-next-step-guidance",
    "fix.mkdir-directive",
    "fix.mock-child-process-in-git-release-suite",
    "fix.multi-file-blocker",
    "fix.noop-counter-survives-session-resume",
    "fix.note-size-cap-measured-in-code-units",
    "fix.package-manifest-license-drift",
    "fix.packages-colocated-specs-unreachable-by-every-tier",
    "fix.patch-file-git-apply-hook-bypass-repro",
    "fix.path-normalization-tests",
    "fix.phase-transition-validation",
    "fix.pipeline-endpoint-events",
    "fix.plan-failure-leaves-empty-run-dir",
    "fix.plan-phase-not-advancing",
    "fix.plan-quality-validation",
    "fix.plan-ready-empty-anchor-fence-detector",
    "fix.plan-ready-heading-scan-rescans-per-target",
    "fix.plan-ready-out-of-band-marker-false-ready",
    "fix.plan-ready-story-wide-search-pattern-cross-file-clear",
    "fix.plan-ready-testrequirement-correspondence",
    "fix.plan-worker-async-marker-regression",
    "fix.planner-inject-package-scripts",
    "fix.planner-paired-test-guard-strips-edit-steps",
    "fix.planner-should-always-include-target-file-content",
    "fix.planner-variable-collision-detection",
    "fix.po-auto-commit-story-notes",
    "fix.preflight-auto-commit-reliability",
    "fix.preflight-branch-mismatch-warning",
    "fix.preflight-empty-remote-reads-unreachable",
    "fix.preflight-working-branch-resolver-divergence",
    "fix.problem-id-required-on-ship",
    "fix.project-init-wires-no-origin-remote",
    "fix.provenance-mcp-tool-gap",
    "fix.publish-empty-namespace-skip",
    "fix.push-bash-hook-to-staging",
    "fix.pytest-collection-args-duplicate-color-flag",
    "fix.qa-flow-body-edit-routing",
    "fix.rag-chunk-whitespace-preservation",
    "fix.rag-context-readers-no-fidelity-filtering",
    "fix.rag-embed-blacklist-pattern",
    "fix.rag-embed-bloat-cleanup",
    "fix.rag-embed-status-does-not-answer-in-index",
    "fix.rag-note-glob-namespace-coverage",
    "fix.read-classification-use-path-utils",
    "fix.read-provenance-research-mode",
    "fix.redirect-hook-governor-bypass-parity",
    "fix.refine-add-search-pattern-suggestion",
    "fix.refine-advisory-in-process-consumers",
    "fix.refine-apply-create-file-directive-handler",
    "fix.refine-apply-fix-duplicate-frontmatter-enum",
    "fix.refine-catch-duplicate-frontmatter",
    "fix.refine-injection-reported-but-not-durable",
    "fix.refine-snippet-function-aware",
    "fix.refine-snippet-keyword-injection.child-1",
    "fix.refine-snippet-keyword-injection.child-2",
    "fix.refine-snippet-stale-refresh",
    "fix.refine-test-identity-transform-assertion",
    "fix.release-ci-gate-missing-gh-reported-as-timeout",
    "fix.release-fetch-exit-status-ignored",
    "fix.release-preflight-push-governor-notecommits",
    "fix.release-resume-reports-empty-released-stories",
    "fix.release-version-bump-package-glob",
    "fix.remove-ac-count-limit",
    "fix.remove-enforce-code-context-hook",
    "fix.replace-body-validation",
    "fix.require-modification-specs",
    "fix.research-agent-redacts-secrets-in-citations",
    "fix.research-agent-subject-binding",
    "fix.research-agent-unbounded-wall-clock",
    "fix.resolve-conflict-delete-handling",
    "fix.restore-dispatcher-discipline.child-2",
    "fix.restore-dispatcher-discipline.child-3",
    "fix.review-default-security-patterns-false-positive-env-lookups",
    "fix.review-section-terminator-not-fence-aware",
    "fix.reviewer-edit-heading-file-path",
    "fix.reviewer-heading-format",
    "fix.reviewer-llm-extraction-failure",
    "fix.rks-agent-dendron-edit-unsafe-large-notes",
    "fix.rks-approve-exec-integration",
    "fix.rks-git-commit-branch-protection",
    "fix.rks-refine-use-dendron-primitives",
    "fix.runtime-path-glob-divergence",
    "fix.runtime-path-glob-matching",
    "fix.search-patterns-required-for-modify",
    "fix.search-replace-custom-markers",
    "fix.session-state-env-var",
    "fix.session-state-test-normalization",
    "fix.session-state-use-path-utils",
    "fix.ship-3branch-workflow",
    "fix.ship-adhoc-staging-path.child-2",
    "fix.ship-pipeline-reliability",
    "fix.ship-review-unmodified-code-not-block",
    "fix.skip-devtools-fix-cascade-sort",
    "fix.slow-dynamic-import-tests",
    "fix.slow-subprocess-test-pattern",
    "fix.smoke-plan-skip-llm-note-only-retry",
    "fix.stale-branch-cleanup.tests.child-2",
    "fix.stale-token-silent-agent-substitution",
    "fix.story-body-oversize-advisory-before-build",
    "fix.story-completion-validation",
    "fix.story-file-lost-after-merge",
    "fix.story-format-validation",
    "fix.story-phase-report-disk-divergence",
    "fix.story-ship-clean-claim-excludes-rks-paths",
    "fix.story-ship-local-only",
    "fix.story-validator-section-extract-truncates-at-subheading",
    "fix.story-writer-prompt",
    "fix.sync-hooks-npm-install-wedges-offrail-session",
    "fix.telemetry-flush-timer-unref",
    "fix.telemetry-metrics-event-types",
    "fix.telemetry-report-malformed-since-discards-startdate",
    "fix.template-body-bleed-through",
    "fix.terminal-story-rks-branch-blocks-unrelated-exec",
    "fix.timeout-opt-out-placeholder-guard",
    "fix.unknown-telemetry-events",
    "fix.update-git-to-mcp-mapping",
    "fix.vite-plugin-syntax-errors",
    "fix.wire-story-validator-to-gate",
    "fix.write-telemetry-stale-authority-session-loss",
  ],
  // Batch 5 (remaining namespaces): every live note outside feat and fix that the --cutoff 2026-10-03 dry run
  // moved in cohort S (no shelve[] entry, no earlier paper row), measured at @494a6d337.
  5: [
    "agents.dispatcher-minimal-params",
    "agents.exec-to-ship-handoff",
    "analyze.framework-profiles.test",
    "architecture.code-rag-strategy",
    "architecture.embedding-optimization",
    "architecture.empty-repo-bootstrap",
    "architecture.exec-extract-backlog-status",
    "architecture.exec-mjs-maintainability-refactor",
    "architecture.multi-agent-orchestration",
    "architecture.plan-phase-checkpoint",
    "architecture.planner-extract-prompt-assembly",
    "architecture.self-improvement-loop",
    "attach-with-optional-stack-template",
    "base-template-mcp-config",
    "branch-control",
    "bug.decompose-inherits-create-op",
    "bug.embed-double-stats-write",
    "bug.embed-noop-returns-false",
    "bug.planner-create-file-dropped",
    "bug.planner-note-step-in-exec",
    "bug.planner-overwrites-file-instead-of-append",
    "bug.planner-whitespace-hallucination",
    "bug.selective-scope-autoship-clean",
    "bug.story-ship-currentbranch-not-defined",
    "bug.telemetry-emit-signature",
    "change-management-gaps.08-gate-edit-write-tools",
    "child-project-seed-notes",
    "child-template-onboarding-hook",
    "chore.migrate-prose-priority-to-frontmatter",
    "chore.oss-repo-publish-hygiene",
    "chore.qa-prompt-collect-then-assert-phrasing",
    "chore.surface-e2e-tier",
    "cli.plan-validate-apply-commands",
    "content.deep-dive-series-post-3",
    "content.deep-dive-series-post-4",
    "content.mcp-vs-skills-hybrid",
    "content.tweet-threads-public-launch",
    "content.ux287-blog-public-launch-announcement",
    "dashboard.failure-breakdown",
    "dendron-backlog-schema-template",
    "dendron-mcp-fix",
    "dendron-mcp.verify-write-persistence",
    "deprecate.remove-code-context",
    "docs.cli-plan-apply-overview",
    "docs.state-machine-workflow",
    "docs.stranded-story-recovery-runbook",
    "dogfooding.06-rag-query-accuracy",
    "dogfooding.09-exec-and-working-tree-cleanup",
    "epic.fix-provenance-panic-mode",
    "epic.governor-orchestration",
    "epic.mro-backlog-platform",
    "epic.rks-developer-mode",
    "epic.test-quality-enforcement",
    "feature.guardrails-off-mcp-prompt",
    "feature.more-telemetry-dashboarding",
    "feature.provenance-hierarchy",
    "feature.telemetry-cycle-enrichment",
    "feature.telemetry-emission-gaps",
    "feature.telemetry-guardrails-enrichment",
    "feature.telemetry-hooks-refine-enrichment",
    "feature.telemetry-pr-enrichment",
    "feature.telemetry-problemid-table",
    "feature.telemetry-ship-enrichment",
    "feature.telemetry-storyship-enrichment",
    "figma-mcp",
    "figma-stdio-bridge",
    "fix-dendron-shape-in-child-projects",
    "guardrails.agent-decision-tree-enforcement",
    "guardrails.branch-divergence-warning-hook",
    "guardrails.code-access-via-rag",
    "guardrails.policy-change-review",
    "guardrails.restrict-agent-bypass",
    "guardrails.telemetry-dashboard",
    "hardening.exec-governance-integration",
    "hooks.progressive-provenance-cone",
    "hooks.provenance-bridge",
    "init-complete-next-steps",
    "init-local-dev-package-json",
    "init-writes-needs-onboarding",
    "interview-skip-known-answers",
    "interview-stuck-recovery",
    "mvp-final-hardening.04-release-pinning.01-release-branch-commands",
    "observability.planning-workflow-telemetry.01-quality-phase",
    "orchestration",
    "planner-create-file-support",
    "planner.apply-workflow-telemetry.01-record-helper",
    "planner.create-file-mvp-constraint",
    "planner.create-file-support",
    "planner.escape-routes",
    "planner.js-not-ts-annotations",
    "planner.library-project-targets",
    "planner.reduce-escape-plan-thinking",
    "planner.requirements-flexibility.phase-1",
    "planner.requirements-flexibility.phase-2",
    "planner.requirements-flexibility.phase-2-1",
    "planner.requirements-flexibility.phase-3",
    "planner.retry-on-note-only-output",
    "planner.syntax-validation",
    "planner.targets-globs-and-directories.test",
    "planner.verification-schema",
    "playbooks.child-project-redesign",
    "polish.onboarding-clone-ux-cleanup",
    "project-attach.migration-contract-and-framework-seeds",
    "project-auto-discovery",
    "project-init.welcome-note-frontmatter",
    "project-init.welcome-note-naming",
    "promised-land",
    "rag-init-clean-tree-scope",
    "rag.direct-file-chunk-query",
    "rag.enhancements.02-semantic-chunking",
    "rag.enhancements.08-context-packaging",
    "rag.enhancements.09-contextual-embeddings",
    "rag.status-aware-relevance-boost",
    "rag.verify-incremental-embedding",
    "reduce-clean-tree-friction",
    "refactor.consolidate-branch-config",
    "refactor.deprecate-rks-git-tools",
    "refactor.gh-release-test-remove-resetmodules",
    "refactor.init-scaffold-only",
    "refactor.read-provenance-unify-divergent-paths",
    "refine-apply-auto-embed",
    "release-branch-workflow",
    "release.v0-3-0-checklist",
    "research.memory-layer-comparison",
    "rks-exec.mcp-env-debug",
    "rks-verify",
    "scaffold-story-type",
    "telemetry.emit-mcp-tool",
    "telemetry.rag-usage-tracking",
    "template-mcp-permissions",
    "test-test-test",
    "test.coverage-enforcement",
    "test.harness-framework",
    "test.rks-test-status-tool",
    "test.test-metadata-categorization",
    "ux287-telemetry-feedback",
    "vendoring.bootstrap-rag-embed",
    "vendoring.dendron-mcp-child-projects",
    "vendoring.full-copy-on-init-attach",
    "vendoring.mcp-config-standard",
    "vendoring.mcp-dendron-core",
    "vendoring.project-onboarding",
    "vendoring.toolchain-contract",
    "vscode-dendron-schema-template-gap",
    "workflow.cherry-pick-backlog-to-feature",
    "workflow.integration-test-phase",
    "workflow.post-exec-auto-merge",
    "workflow.release-ceremony",
    "workflow.safe-merge-unwind",
  ],
};

const manifest = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "scripts", "backlog-archive-manifest.json"), "utf8"));
const mine = manifest.doneInCode.filter((e) => typeof e.$comment === "string" && e.$comment.includes(STORY));
const paperText = () => fs.readFileSync(PAPER, "utf8");
const batches = () => Object.keys(REMAINING).map(Number);
const commentBatch = (comment) => { const m = /\bbatch (\d+)\b/.exec(comment); return m ? Number(m[1]) : NaN; };
const cellBatch = (cell) => { const m = /^(\d+)\b/.exec(cell || ""); return m ? Number(m[1]) : NaN; };
const reasonBatch = (reason) => { const m = /^batch (\d+)\b/.exec(reason || ""); return m ? Number(m[1]) : NaN; };

function verdictRows(text) {
  const start = text.indexOf("## Verdicts");
  expect(start).toBeGreaterThan(-1);
  const rows = [];
  for (const line of text.slice(start).split("\n").slice(1)) {
    if (line.startsWith("## ")) break;
    if (!line.startsWith("|")) continue;
    const cells = line.split("|").slice(1, -1).map((c) => c.trim());
    if (cells[0] === "note" || /^-+$/.test(cells[0])) continue;
    rows.push({ note: cells[0].replace(/`/g, ""), batch: cells[1], verdict: cells[2] });
  }
  return rows;
}

function heldRows(text) {
  const start = text.indexOf("## Held for another reason");
  const end = text.indexOf("## Verdicts");
  expect(start).toBeGreaterThan(-1);
  const rows = [];
  for (const line of text.slice(start, end).split("\n").slice(1)) {
    if (!line.startsWith("|")) continue;
    const cells = line.split("|").slice(1, -1).map((c) => c.trim());
    if (cells[0] === "note" || /^-+$/.test(cells[0])) continue;
    rows.push({ note: cells[0].replace(/`/g, ""), reason: cells.slice(1).join("|") });
  }
  return rows;
}

function evidenceFound(entry) {
  return Array.isArray(entry.evidence) && entry.evidence.length > 0 && entry.evidence.every((ev) => {
    if (!ev || typeof ev.file !== "string" || typeof ev.literal !== "string" || ev.literal.length === 0) return false;
    const abs = path.join(REPO_ROOT, ev.file);
    return fs.existsSync(abs) && fs.readFileSync(abs, "utf8").includes(ev.literal);
  });
}

describe("done-in-code pass remaining namespaces", () => {
  it("the build-time candidate set is recorded by batch from batch 3 onward", () => {
    expect(batches().length).toBeGreaterThan(0);
    for (const n of batches()) {
      expect(n).toBeGreaterThanOrEqual(3);
      expect(REMAINING[n].length, `batch ${n}`).toBeGreaterThan(0);
    }
    const all = batches().flatMap((n) => REMAINING[n]);
    expect(new Set(all).size).toBe(all.length);
    for (const id of all) expect(id.startsWith(P), id).toBe(false);
  });

  it("every doneInCode entry this story adds has evidence found in its file", () => {
    for (const e of mine) expect(evidenceFound(e), e.id).toBe(true);
  });

  it("every entry this story adds names a batch from 3 onward that examined it and does not name the predecessor story", () => {
    for (const e of mine) {
      const n = commentBatch(e.$comment);
      expect(n >= 3, e.id).toBe(true);
      expect(REMAINING[n] || [], e.id).toContain(e.id.slice(P.length));
      expect(e.$comment.includes(PREDECESSOR), e.id).toBe(false);
    }
  });

  it("every entry this story adds has a done verdict row in its own batch", () => {
    const rows = verdictRows(paperText());
    for (const e of mine) {
      const r = rows.filter((x) => x.note === e.id.slice(P.length));
      expect(r.length, e.id).toBe(1);
      expect(r[0].verdict, e.id).toBe("done");
      expect(cellBatch(r[0].batch), e.id).toBe(commentBatch(e.$comment));
    }
  });

  it("every candidate appears in exactly one paper row and that row is in its own batch", () => {
    const text = paperText();
    const rows = verdictRows(text);
    const held = heldRows(text);
    const ids = new Set(manifest.doneInCode.map((e) => e.id));
    for (const n of batches()) {
      for (const id of REMAINING[n]) {
        const v = rows.filter((r) => r.note === id);
        const h = held.filter((r) => r.note === id);
        expect(v.length + h.length, id).toBe(1);
        if (v.length) {
          expect(cellBatch(v[0].batch), id).toBe(n);
          expect(["done", "unclear"], id).toContain(v[0].verdict);
        } else {
          expect(reasonBatch(h[0].reason), id).toBe(n);
          expect(ids.has(full(id)), id).toBe(false);
        }
      }
    }
  });

  it("no unclear row and no held row from batch 3 onward has a doneInCode entry", () => {
    const text = paperText();
    const ids = new Set(manifest.doneInCode.map((e) => e.id));
    for (const r of verdictRows(text).filter((x) => cellBatch(x.batch) >= 3 && x.verdict !== "done")) {
      expect(ids.has(full(r.note)), r.note).toBe(false);
    }
    for (const r of heldRows(text).filter((x) => reasonBatch(x.reason) >= 3)) {
      expect(ids.has(full(r.note)), r.note).toBe(false);
    }
  });

  it("each batch-3-onward done note is at its z_implemented destination with cohort metadata and the live file is gone", () => {
    for (const r of verdictRows(paperText()).filter((x) => cellBatch(x.batch) >= 3 && x.verdict === "done")) {
      const id = full(r.note);
      const dest = destinationFor(id, "z_implemented");
      const abs = path.join(NOTES, dest + MD);
      expect(fs.existsSync(abs), dest).toBe(true);
      expect(fs.existsSync(path.join(NOTES, id + MD)), r.note).toBe(false);
      const data = parseFrontmatter(fs.readFileSync(abs, "utf8")).data;
      expect(data.id).toBe(dest);
      expect(data.status).toBe("implemented");
      expect(data.archiveCohort).toBe("done-in-code");
      expect(Array.isArray(data.archiveEvidence) && data.archiveEvidence.length > 0, dest).toBe(true);
    }
  });

  it("the paper records a dry-run digest and git anchor for every batch from 3 onward", () => {
    const text = paperText();
    const heldAt = text.indexOf("## Held for another reason");
    expect(heldAt).toBeGreaterThan(-1);
    for (const n of batches()) {
      const at = text.indexOf(`\nBatch ${n} (`);
      expect(at, `batch ${n}`).toBeGreaterThan(-1);
      expect(at, `batch ${n}`).toBeLessThan(heldAt);
      const rest = text.slice(at + 1, heldAt);
      const next = rest.search(/\nBatch \d+ \(/);
      const block = next === -1 ? rest : rest.slice(0, next);
      expect(block, `batch ${n}`).toMatch(/^- Dry-run digest: [0-9a-f]{64}\s*$/m);
      expect(block, `batch ${n}`).toMatch(/^- Git anchor: @[0-9a-f]{7,}/m);
    }
  });

  it("the paper names this story by its stripped id and never by its full id", () => {
    const text = paperText();
    expect(text.includes(STORY)).toBe(true);
    expect(text.includes(full(STORY))).toBe(false);
  });

  it("no shelve[] note and no held[] note is a candidate or gets a doneInCode entry", () => {
    const shelveIds = (manifest.shelve || []).map((e) => e.id);
    const heldIds = (manifest.held || []).map((e) => e.id);
    expect(shelveIds.length).toBeGreaterThan(0);
    const all = new Set(batches().flatMap((n) => REMAINING[n]).map(full));
    const ids = new Set(manifest.doneInCode.map((e) => e.id));
    for (const id of shelveIds) {
      expect(all.has(id), id).toBe(false);
      expect(ids.has(id), id).toBe(false);
    }
    for (const e of mine) expect(heldIds.includes(e.id), e.id).toBe(false);
  });
});
