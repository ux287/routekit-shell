export interface TelemetryEvent {
  id: string;
  type: string;
  timestamp: string;
  projectId: string;
  correlationId: string | null;
  runId: string | null;
  payload: Record<string, unknown>;
  context: Record<string, unknown>;
}

export type EventCategory =
  | 'exec'
  | 'plan'
  | 'test'
  | 'guardrails'
  | 'mcp'
  | 'pr'
  | 'cycle'
  | 'hooks'
  | 'refine'
  | 'story_ship';

export interface TelemetryMetrics {
  totalEvents: number;
  eventsByType: Record<string, number>;
  recentActivity: TelemetryEvent[];
  trends: {
    daily: Array<{ date: string; count: number }>;
    hourly: Array<{ hour: number; count: number }>;
  };
}

export interface StoryActivity {
  problemId: string;
  eventCount: number;
  lastActivity: string;
  execCount: number;
  execSuccess: number;
  execFailed: number;
  eventTypes: string[];
}

export interface DateRange {
  start: string | null;
  end: string | null;
}

export interface Filters {
  startDate: string | null;
  endDate: string | null;
  type: string | null;
  projectId: string | null;
}

export interface HealthData {
  status: 'healthy' | 'degraded' | 'unhealthy';
  score: number;
  details: {
    totalEvents: number;
    errorEvents: number;
    errorRate: number;
    execSuccess: number;
    execFailed: number;
    execSuccessRate: number;
  };
}

export interface PipelineData {
  planned: number;
  executed: number;
  shipped: number;
  execRate: number;
  shipRate: number;
}

export interface LatencyOperation {
  operation: string;
  count: number;
  avg: number;
  p50: number;
  p95: number;
  max: number;
}

export interface LatencyData {
  operations: LatencyOperation[];
}

export interface TrustData {
  trustScore: number;
  guardrailsTriggered: number;
  guardrailsPassed: number;
  offRailSessions: number;
  hooksBlocked: number;
  hooksAllowed: number;
}

export type TimeRangePreset = '24h' | '7d' | '30d' | 'custom';

export interface DashboardFilters {
  timeRange: TimeRangePreset;
  startDate: string | null;
  endDate: string | null;
  onlyFailures: boolean;
  project: string | null;
}
