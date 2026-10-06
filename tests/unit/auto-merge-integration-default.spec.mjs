import { describe, it, expect } from 'vitest';
import { getBranchConfig, getWorkflowConfig } from '../../packages/mcp-rks/src/server/project.mjs';

describe('auto-merge integration defaults', () => {
  describe('single-branch workflow (working === integration)', () => {
    it('should default autoMergeIntegration to true', () => {
      const projectRecord = {
        branches: {
          working: 'staging',
          integration: 'staging',
          production: 'main'
        }
      };
      
      const config = getWorkflowConfig(projectRecord);
      expect(config.autoMergeIntegration).toBe(true);
    });

    it('should default autoMergeIntegration to true with default config', () => {
      const projectRecord = {}; // Uses defaults: working=staging, integration=staging
      
      const config = getWorkflowConfig(projectRecord);
      expect(config.autoMergeIntegration).toBe(true);
    });
  });

  describe('3-branch workflow (working !== integration)', () => {
    it('should default autoMergeIntegration to false', () => {
      const projectRecord = {
        branches: {
          working: 'dev',
          integration: 'staging', 
          production: 'main'
        }
      };
      
      const config = getWorkflowConfig(projectRecord);
      expect(config.autoMergeIntegration).toBe(false);
    });

    it('should respect explicit autoMergeIntegration: true override', () => {
      const projectRecord = {
        branches: {
          working: 'dev',
          integration: 'staging',
          production: 'main'
        },
        workflow: {
          autoMergeIntegration: true
        }
      };
      
      const config = getWorkflowConfig(projectRecord);
      expect(config.autoMergeIntegration).toBe(true);
    });

    it('should respect explicit autoMergeIntegration: false', () => {
      const projectRecord = {
        branches: {
          working: 'dev',
          integration: 'staging',
          production: 'main'
        },
        workflow: {
          autoMergeIntegration: false
        }
      };
      
      const config = getWorkflowConfig(projectRecord);
      expect(config.autoMergeIntegration).toBe(false);
    });
  });

  describe('single-branch workflow with explicit overrides', () => {
    it('should respect explicit autoMergeIntegration: false for single-branch', () => {
      const projectRecord = {
        branches: {
          working: 'staging',
          integration: 'staging',
          production: 'main'
        },
        workflow: {
          autoMergeIntegration: false
        }
      };
      
      const config = getWorkflowConfig(projectRecord);
      expect(config.autoMergeIntegration).toBe(false);
    });

    it('should respect explicit autoMergeIntegration: true for single-branch', () => {
      const projectRecord = {
        branches: {
          working: 'staging',
          integration: 'staging',
          production: 'main'
        },
        workflow: {
          autoMergeIntegration: true
        }
      };
      
      const config = getWorkflowConfig(projectRecord);
      expect(config.autoMergeIntegration).toBe(true);
    });
  });

  describe('other workflow settings preserved', () => {
    it('should preserve other workflow config defaults', () => {
      const projectRecord = {
        branches: {
          working: 'dev',
          integration: 'staging',
          production: 'main'
        }
      };
      
      const config = getWorkflowConfig(projectRecord);
      expect(config.workingBranchLocal).toBe(false); // Default value
    });

    it('should preserve explicit workflow settings', () => {
      const projectRecord = {
        branches: {
          working: 'dev', 
          integration: 'staging',
          production: 'main'
        },
        workflow: {
          workingBranchLocal: true
        }
      };
      
      const config = getWorkflowConfig(projectRecord);
      expect(config.autoMergeIntegration).toBe(false); // 3-branch default
      expect(config.workingBranchLocal).toBe(true); // Explicit setting
    });
  });
});
