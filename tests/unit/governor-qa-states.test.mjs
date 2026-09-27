import { describe, it, expect } from 'vitest';
import {
  getStates,
  checkStateAllowed,
  getNextState,
  transitionOnResult,
  isTerminal,
  QA_FLOW_TOOLS,
} from '../../packages/mcp-rks/src/shared/governor-state.mjs';

describe('QA Governor State Machine', () => {
  describe('QA_STATES definition', () => {
    it('should have init state with research tools', () => {
      const states = getStates('qa');
      expect(states.init).toBeDefined();
      expect(states.init.allowed.has('rks_agent_research')).toBe(true);
      expect(states.init.allowed.has('rks_governor_init')).toBe(true);
    });

    it('should have researching state with research and dendron tools', () => {
      const states = getStates('qa');
      expect(states.researching).toBeDefined();
      expect(states.researching.allowed.has('rks_agent_research')).toBe(true);
      expect(states.researching.allowed.has('dendron_create_note')).toBe(true);
    });

    it('should have qa_testing state with limited tools', () => {
      const states = getStates('qa');
      expect(states.qa_testing).toBeDefined();
      expect(states.qa_testing.allowed.has('rks_agent_git')).toBe(true);
      expect(states.qa_testing.allowed.has('rks_project_get')).toBe(true);
      expect(states.qa_testing.allowed.has('rks_refine')).toBe(false);
      expect(states.qa_testing.allowed.has('rks_exec')).toBe(false);
    });

    it('should have qa_assessing state for result analysis', () => {
      const states = getStates('qa');
      expect(states.qa_assessing).toBeDefined();
      expect(states.qa_assessing.allowed.has('dendron_edit_note')).toBe(true);
      expect(states.qa_assessing.allowed.has('dendron_update_field')).toBe(true);
    });

    it('should have qa_reporting state for report generation', () => {
      const states = getStates('qa');
      expect(states.qa_reporting).toBeDefined();
      expect(states.qa_reporting.allowed.has('dendron_create_note')).toBe(true);
      expect(states.qa_reporting.allowed.has('dendron_update_field')).toBe(true);
    });

    it('should have shipped terminal state', () => {
      const states = getStates('qa');
      expect(states.shipped).toBeDefined();
      expect(states.shipped.allowed.has('rks_project_get')).toBe(true);
    });

    it('should have failed terminal state', () => {
      const states = getStates('qa');
      expect(states.failed).toBeDefined();
      expect(states.failed.allowed.has('rks_project_get')).toBe(true);
    });
  });

  describe('Tool allowlists', () => {
    it('should NOT allow Build phase tools in QA states', () => {
      const buildPhaseTools = ['rks_refine', 'rks_refine_apply', 'rks_plan', 'rks_plan_review', 'rks_exec', 'rks_exec_abort'];
      const states = getStates('qa');
      const qaStates = ['init', 'researching', 'qa_testing', 'qa_assessing', 'qa_reporting'];
      
      for (const stateName of qaStates) {
        for (const tool of buildPhaseTools) {
          expect(states[stateName].allowed.has(tool)).toBe(false);
        }
      }
    });

    it('should NOT allow Ship phase tools in QA states', () => {
      const shipPhaseTools = ['rks_ship', 'rks_story_ship'];
      const states = getStates('qa');
      const qaStates = ['init', 'researching', 'qa_testing', 'qa_assessing', 'qa_reporting'];
      
      for (const stateName of qaStates) {
        for (const tool of shipPhaseTools) {
          expect(states[stateName].allowed.has(tool)).toBe(false);
        }
      }
    });

    it('should allow research and dendron tools', () => {
      const researchTools = ['rks_agent_research', 'rks_agent_external_research'];
      const dendronTools = ['dendron_create_note', 'dendron_edit_note', 'dendron_read_note', 'dendron_update_field'];
      const states = getStates('qa');
      
      for (const tool of researchTools) {
        expect(states.researching.allowed.has(tool)).toBe(true);
      }
      
      for (const tool of dendronTools) {
        expect(states.researching.allowed.has(tool) || 
                states.qa_assessing.allowed.has(tool) || 
                states.qa_reporting.allowed.has(tool)).toBe(true);
      }
    });
  });

  describe('QA_FLOW_TOOLS constant', () => {
    it('should export QA_FLOW_TOOLS set', () => {
      expect(QA_FLOW_TOOLS).toBeDefined();
      expect(QA_FLOW_TOOLS instanceof Set).toBe(true);
    });

    it('should include research tools', () => {
      expect(QA_FLOW_TOOLS.has('rks_agent_research')).toBe(true);
      expect(QA_FLOW_TOOLS.has('rks_agent_external_research')).toBe(true);
    });

    it('should include dendron tools', () => {
      expect(QA_FLOW_TOOLS.has('dendron_create_note')).toBe(true);
      expect(QA_FLOW_TOOLS.has('dendron_edit_note')).toBe(true);
      expect(QA_FLOW_TOOLS.has('dendron_read_note')).toBe(true);
      expect(QA_FLOW_TOOLS.has('dendron_update_field')).toBe(true);
    });

    it('should include governor init', () => {
      expect(QA_FLOW_TOOLS.has('rks_governor_init')).toBe(true);
    });

    it('should exclude Build phase tools', () => {
      expect(QA_FLOW_TOOLS.has('rks_refine')).toBe(false);
      expect(QA_FLOW_TOOLS.has('rks_plan')).toBe(false);
      expect(QA_FLOW_TOOLS.has('rks_exec')).toBe(false);
    });

    it('should exclude Ship phase tools', () => {
      expect(QA_FLOW_TOOLS.has('rks_ship')).toBe(false);
      expect(QA_FLOW_TOOLS.has('rks_story_ship')).toBe(false);
    });
  });

  describe('State transitions', () => {
    it('should transition from researching on research.complete', () => {
      const nextState = transitionOnResult('qa', 'researching', 'research.complete');
      expect(nextState).toBe('qa_testing');
    });

    it('should transition to failed on test failure', () => {
      const nextState = transitionOnResult('qa', 'qa_testing', 'qa.tests_failed');
      expect(nextState).toBe('failed');
    });

    it('should transition from qa_testing to qa_assessing on tests_complete', () => {
      const nextState = transitionOnResult('qa', 'qa_testing', 'qa.tests_complete');
      expect(nextState).toBe('qa_assessing');
    });

    it('should transition from qa_assessing to qa_reporting on assessment_pass', () => {
      const nextState = transitionOnResult('qa', 'qa_assessing', 'qa.assessment_pass');
      expect(nextState).toBe('qa_reporting');
    });

    it('should transition from qa_assessing to failed on assessment_fail', () => {
      const nextState = transitionOnResult('qa', 'qa_assessing', 'qa.assessment_fail');
      expect(nextState).toBe('failed');
    });

    it('should transition from qa_reporting to shipped on report_complete', () => {
      const nextState = transitionOnResult('qa', 'qa_reporting', 'qa.report_complete');
      expect(nextState).toBe('shipped');
    });

    it('should transition to failed on report_failed', () => {
      const nextState = transitionOnResult('qa', 'qa_reporting', 'qa.report_failed');
      expect(nextState).toBe('failed');
    });
  });

  describe('Tool validation', () => {
    it('should allow rks_agent_research in init state', () => {
      const result = checkStateAllowed('qa', 'init', 'rks_agent_research');
      expect(result.allowed).toBe(true);
    });

    it('should allow dendron_create_note in researching state', () => {
      const result = checkStateAllowed('qa', 'researching', 'dendron_create_note');
      expect(result.allowed).toBe(true);
    });

    it('should deny rks_refine in all QA states', () => {
      const states = getStates('qa');
      for (const stateName of Object.keys(states)) {
        if (stateName === 'shipped' || stateName === 'failed') continue;
        const result = checkStateAllowed('qa', stateName, 'rks_refine');
        expect(result.allowed).toBe(false);
      }
    });

    it('should deny rks_exec in all QA states', () => {
      const states = getStates('qa');
      for (const stateName of Object.keys(states)) {
        if (stateName === 'shipped' || stateName === 'failed') continue;
        const result = checkStateAllowed('qa', stateName, 'rks_exec');
        expect(result.allowed).toBe(false);
      }
    });

    it('should deny rks_ship in all QA states', () => {
      const states = getStates('qa');
      for (const stateName of Object.keys(states)) {
        if (stateName === 'shipped' || stateName === 'failed') continue;
        const result = checkStateAllowed('qa', stateName, 'rks_ship');
        expect(result.allowed).toBe(false);
      }
    });
  });

  describe('Terminal states', () => {
    it('should identify shipped as terminal in QA flow', () => {
      expect(isTerminal('qa', 'shipped')).toBe(true);
    });

    it('should identify failed as terminal in QA flow', () => {
      expect(isTerminal('qa', 'failed')).toBe(true);
    });

    it('should not identify researching as terminal', () => {
      expect(isTerminal('qa', 'researching')).toBe(false);
    });

    it('should not identify qa_testing as terminal', () => {
      expect(isTerminal('qa', 'qa_testing')).toBe(false);
    });
  });
});
