import { useQuery } from '@tanstack/react-query';
import { fetchEvents, FetchEventsOptions, TelemetryEvent } from '../lib/api';
import { useFilters } from '../lib/FilterContext';

export function useTelemetryEvents(options: FetchEventsOptions = {}) {
  const { filters } = useFilters();
  const project = filters.project;
  const mergedOptions = { ...options, project };
  return useQuery<{ events: TelemetryEvent[]; total: number }>({
    queryKey: ['telemetry-events', mergedOptions],
    queryFn: () => fetchEvents(mergedOptions),
    staleTime: 30000,
  });
}
