import { useQuery } from '@tanstack/react-query';
import { fetchReport, fetchTokenCosts, TelemetryMetrics, TokenCostsResponse } from '../lib/api';
import { useFilters } from '../lib/FilterContext';

export function useTelemetryMetrics() {
  const { filters } = useFilters();
  const project = filters.project;
  return useQuery<TelemetryMetrics>({
    queryKey: ['telemetry-metrics', project],
    queryFn: () => fetchReport('summary', { project }),
    staleTime: 60000,
  });
}

export function useTokenCosts() {
  const { filters } = useFilters();
  const project = filters.project;
  return useQuery<TokenCostsResponse>({
    queryKey: ['telemetry', 'token-costs', project],
    queryFn: () => fetchTokenCosts({ project }),
    staleTime: 60000,
  });
}
