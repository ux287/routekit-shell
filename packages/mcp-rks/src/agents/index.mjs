/**
 * Agent Factory Barrel Export
 *
 * Re-exports all agent factories for clean cross-imports.
 * Used by cross-delegation tools and composite agents.
 *
 * @see backlog.agents.agent-cross-delegation
 */

export { createProductOwnerAgent, ProductOwnerInputSchema } from './product-owner.mjs';
export { createResearchAgent, ResearchInputSchema } from './research.mjs';
export { createGitAgent, GitInputSchema } from './git.mjs';
export { createDendronAgent, DendronInputSchema } from './dendron.mjs';
export { createTelemetryAgent, TelemetryInputSchema } from './telemetry.mjs';
export { createShipAgent, ShipInputSchema } from './ship.mjs';
export { createCycleCompleteAgent, CycleCompleteInputSchema } from './cycle-complete.mjs';
export { createStoryAgent, StoryInputSchema } from './story.mjs';
export { createDeliveryAgent, DeliveryInputSchema } from './delivery.mjs';
export { createRecoveryAgent, RecoveryInputSchema } from './recovery.mjs';
export { createPlannerAgent, PlannerInputSchema } from './planner.mjs';

// Cross-delegation utilities
export { createCrossDelegationTool, createDelegationCounter } from './cross-delegate.mjs';

// Registry and runner
export { getAgent, listAgents, generateAgentToolDefinitions, getAgentByToolName } from './registry.mjs';
export { runAgent } from './runner.mjs';
