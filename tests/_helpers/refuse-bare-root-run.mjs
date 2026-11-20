// backlog.fix.root-vitest-setupfiles-gate — ARCH Option B: the root config refuses.
//
// vitest.config.mjs, and ONLY vitest.config.mjs, lists this file as its globalSetup.
// Vitest loads a globalSetup module only when it starts a RUN with that config, i.e. a
// `vitest run` at the repo root with no --config, before any test file is collected.
// Throwing here aborts that run with the message below and no per-test result list.
// A plain import() of vitest.config.mjs (the setup-infra, vitest-config-shared-base and
// vitest-tiers tests do that) never loads this module, so the config stays importable.
//
// NEVER reference this file from vitest.config.base.mjs: the base is merged into every
// tier, so it would refuse npm run test:unit / test:mock / test:e2e as well.
//
// This path matches neither root include glob (tests/**/*.test.*, tests/**/*.spec.*), so
// vitest never collects it as a test. Keep it that way if it is ever moved.

export const REFUSAL_TAG = "RKS_BARE_ROOT_VITEST_REFUSED";

export const SUPPORTED_COMMANDS = Object.freeze([
  "npm run test:unit",
  "npm run test:mock",
  "npm run test:e2e",
  "npx vitest run --config vitest.config.<unit|mock|e2e>.mjs <path>",
  "npx vitest run --config vitest.config.workflow.mjs <path>   (tests/integration/**/*.workflow.test.* only)",
]);

export const REFUSAL_MESSAGE = [
  `${REFUSAL_TAG}: a bare \`vitest run\` with no --config is not a supported test gate in this repo.`,
  "The repo-root config sweeps unit, mock, e2e and workflow-driven files into one run that no",
  "single set of fork/timeout settings serves, and the e2e files make real paid LLM API calls.",
  "Run one of:",
  ...SUPPORTED_COMMANDS.map((cmd) => `  ${cmd}`),
  "See CLAUDE.md (Test Execution) and notes/canon.test-tiers.md.",
].join("\n");

export default function refuseBareRootRun() {
  throw new Error(REFUSAL_MESSAGE);
}
