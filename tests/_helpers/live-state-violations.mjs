// backlog.fix.test-suite-deletes-live-governor-sessions — registered by tests/setup.mjs as an afterEach.
// Fails the current test when packages/mcp-rks/src/shared/live-root-guard.mjs recorded a refused deletion
// of live session or lease state, even if the test swallowed the throw. Reads and empties an in-memory
// array only; it touches no file.
export function checkLiveStateViolations() {
  const violations = globalThis.__RKS_LIVE_STATE_VIOLATIONS__;
  if (!Array.isArray(violations) || violations.length === 0) return;
  const messages = violations.splice(0);
  throw new Error("live session state deletion refused during this test:\n" + messages.join("\n"));
}
