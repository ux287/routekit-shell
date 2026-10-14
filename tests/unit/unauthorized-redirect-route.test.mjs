import { describe, it, expect } from 'vitest';
import {
  unauthorizedResponse,
  OPS_FLOW_TOOLS,
  STORY_FLOW_TOOLS,
  OPEN_FLOW_TOOLS,
} from '../../packages/mcp-rks/src/shared/governor-token.mjs';

const MESSAGE =
  'This tool requires Governor authorization. Do not call it directly — launch a Governor instead.';

const OPS_ONLY = [...OPS_FLOW_TOOLS].filter(
  (t) => !STORY_FLOW_TOOLS.has(t) && !OPEN_FLOW_TOOLS.has(t),
);
const NON_OPS_SAMPLE = ['rks_plan', 'rks_exec', 'rks_refine', 'dendron_create_note'];

describe('unauthorizedResponse names a governed route', () => {
  it('rks_promote redirect names /ops and flowType ops', () => {
    const { action } = unauthorizedResponse('rks_promote').redirect;
    expect(action).toContain('/ops');
    expect(action).toContain("flowType: 'ops'");
  });

  it('rks_release redirect names /release or /ops and flowType ops', () => {
    const { action } = unauthorizedResponse('rks_release').redirect;
    expect(action.includes('/release') || action.includes('/ops')).toBe(true);
    expect(action).toContain("flowType: 'ops'");
  });

  it('every ops-only tool (OPS_FLOW_TOOLS minus story/open sets) names flowType ops', () => {
    expect(OPS_ONLY).toContain('rks_promote');
    for (const tool of OPS_ONLY) {
      expect(unauthorizedResponse(tool).redirect.action, tool).toContain("flowType: 'ops'");
    }
  });

  it('non-ops tools name the governor launch type, never general-purpose', () => {
    for (const tool of NON_OPS_SAMPLE) {
      const { action } = unauthorizedResponse(tool).redirect;
      expect(action, tool).not.toContain('general-purpose');
      expect(action, tool).toContain('governor');
    }
  });

  it('ok, error, tool, message and reason are unchanged for every tool', () => {
    for (const tool of [...OPS_ONLY, ...NON_OPS_SAMPLE]) {
      const r = unauthorizedResponse(tool);
      expect(r.ok).toBe(false);
      expect(r.error).toBe('unauthorized');
      expect(r.tool).toBe(tool);
      expect(r.message).toBe(MESSAGE);
      expect(r.redirect.reason).toContain('rks_governor_init');
    }
  });
});
