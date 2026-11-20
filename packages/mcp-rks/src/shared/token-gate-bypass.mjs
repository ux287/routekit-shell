// backlog.feat.token-gate-bypass-visible
// Pure reader of the process's token-gate bypass state. The protected-tool gate in server.mjs
// derives _skipTokenValidation from tokenGateBypass().active, and the boot report, the mcp.tool
// audit fields and the rks_governor_init tokenGate field all read the same observation.
const BYPASS_CHECKS = [
  ["RKS_SKIP_PREFLIGHT", "1"],
  ["NODE_ENV", "test"],
  ["RKS_TEST_MODE", "1"],
];

export const TOKEN_GATE_BYPASS_EVENT = "governance.token_gate_bypass";

export function tokenGateBypass(env = process.env) {
  const vars = [];
  for (const [name, value] of BYPASS_CHECKS) {
    if (env?.[name] === value) vars.push(`${name}=${value}`);
  }
  return { active: vars.length > 0, vars };
}

// Keys spread onto mcp.tool.complete / mcp.tool.failed payloads. Empty when the gate is
// enforced, so a normal-operation audit event carries no new key.
export function tokenGateAuditFields(env = process.env) {
  const { active, vars } = tokenGateBypass(env);
  return active ? { tokenGate: "bypassed", tokenGateBypassVars: vars } : {};
}

// Called once from startServer(). emit(type, payload) and write(line) are injected so the
// boot report is testable without a live collector or the real stderr. The stderr line
// names variables only; it never starts with "[preflight] removed " (that prefix belongs to
// the bin's .env strip, see tests/unit/mcp-boot-dotenv-bypass-vars.test.mjs).
export function reportTokenGateBypass({ env = process.env, emit, write } = {}) {
  const { active, vars } = tokenGateBypass(env);
  if (!active) return { reported: false, vars };
  emit?.(TOKEN_GATE_BYPASS_EVENT, { vars });
  const names = vars.map((v) => v.split("=")[0]).join(", ");
  write?.(`[mcp] token gate disabled for this process by ${names}\n`);
  return { reported: true, vars };
}
