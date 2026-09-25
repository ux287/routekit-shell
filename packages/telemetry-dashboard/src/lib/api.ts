import type { GuardrailEventsResponse } from './types';

const API_BASE = '/api/telemetry';

export interface FetchEventsOptions {
  type?: string;
  startDate?: string;
  endDate?: string;
  correlationId?: string;
  limit?: number;
  project?: string | null;
}

export interface HealthFilterOptions {
  startDate?: string | null;
  endDate?: string | null;
  type?: string | null;
  project?: string | null;
}

function buildFilterParams(filters?: HealthFilterOptions): string {
  if (!filters) return '';
  const params = new URLSearchParams();
  if (filters.startDate) params.set('startDate', filters.startDate);
  if (filters.endDate) params.set('endDate', filters.endDate);
  if (filters.type) params.set('type', filters.type);
  if (filters.project) params.set('project', filters.project);
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

export async function fetchProjects(): Promise<{ projects: string[] }> {
  const res = await fetch(`${API_BASE}/projects`);
  if (!res.ok) throw new Error('Failed to fetch projects');
  return res.json();
}

export async function fetchEvents(options: FetchEventsOptions = {}) {
  const params = new URLSearchParams();
  if (options.type) params.set('type', options.type);
  if (options.startDate) params.set('startDate', options.startDate);
  if (options.endDate) params.set('endDate', options.endDate);
  if (options.correlationId) params.set('correlationId', options.correlationId);
  if (options.limit) params.set('limit', String(options.limit));
  if (options.project) params.set('project', options.project);

  const res = await fetch(`${API_BASE}/events?${params}`);
  if (!res.ok) throw new Error('Failed to fetch events');
  return res.json();
}

export async function fetchReport(reportType: 'summary' | 'failures' | 'trends' = 'summary', filters?: HealthFilterOptions) {
  const params = new URLSearchParams();
  params.set('reportType', reportType);
  if (filters?.project) params.set('project', filters.project);
  const res = await fetch(`${API_BASE}/report?${params}`);
  if (!res.ok) throw new Error('Failed to fetch report');
  return res.json();
}

export async function fetchStoriesActivity(filters?: HealthFilterOptions) {
  const res = await fetch(`${API_BASE}/by-story${buildFilterParams(filters)}`);
  if (!res.ok) throw new Error('Failed to fetch story activity');
  return res.json();
}

export async function fetchHealth(filters?: HealthFilterOptions) {
  const res = await fetch(`${API_BASE}/health${buildFilterParams(filters)}`);
  if (!res.ok) throw new Error('Failed to fetch health');
  return res.json();
}

export async function fetchPipeline(filters?: HealthFilterOptions) {
  const res = await fetch(`${API_BASE}/pipeline${buildFilterParams(filters)}`);
  if (!res.ok) throw new Error('Failed to fetch pipeline');
  return res.json();
}

export async function fetchLatency(filters?: HealthFilterOptions) {
  const res = await fetch(`${API_BASE}/latency${buildFilterParams(filters)}`);
  if (!res.ok) throw new Error('Failed to fetch latency');
  return res.json();
}

export async function fetchTrust(filters?: HealthFilterOptions) {
  const res = await fetch(`${API_BASE}/trust${buildFilterParams(filters)}`);
  if (!res.ok) throw new Error('Failed to fetch trust');
  return res.json();
}

export interface StoryCostData {
  storyId: string;
  rawCost: number;
  wasteRatio: number;
  cacheRatio: number;
  healthBand: 'green' | 'yellow' | 'red';
}

export interface DailySeriesEntry {
  date: string;
  rawCost: number;
  wasteRatio: number;
  cacheRatio: number;
  noData: boolean;
}

export interface ByModelEntry {
  calls: number;
  tokens: number;
  share: number;
}

export interface TokenCostsResponse {
  stories: StoryCostData[];
  dailySeries: DailySeriesEntry[];
  // Aggregate cache economics + model mix (backlog.feat.cost-report-cache-and-model-rollup).
  // Optional so older API responses (pre-rollup) still type-check.
  cacheRatio?: number;
  cacheCreate?: number;
  cacheBreakdown?: { write: number; read: number; uncached: number };
  byModel?: Record<string, ByModelEntry>;
}

export async function fetchTokenCosts(filters?: HealthFilterOptions): Promise<TokenCostsResponse> {
  const res = await fetch(`${API_BASE}/token-costs${buildFilterParams(filters)}`);
  if (!res.ok) throw new Error('Failed to fetch token costs');
  return res.json();
}

export async function fetchGuardrailEvents(filters?: HealthFilterOptions): Promise<GuardrailEventsResponse> {
  const res = await fetch(`${API_BASE}/guardrail-events${buildFilterParams(filters)}`);
  if (!res.ok) throw new Error('Failed to fetch guardrail events');
  return res.json();
}

// Re-export types from the central types file
export type { TelemetryEvent, TelemetryMetrics, StoryActivity, HealthData, PipelineData, LatencyData, LatencyOperation, TrustData } from './types';
