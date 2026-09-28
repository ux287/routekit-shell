import { createContext, useContext, useState, useCallback, ReactNode, useMemo } from 'react';
import { TimeRangePreset, DashboardFilters } from './types';

export const DEFAULT_FILTERS: DashboardFilters = {
  timeRange: '24h',
  startDate: null,
  endDate: null,
  onlyFailures: false,
  project: null,
};

interface FilterContextValue {
  filters: DashboardFilters;
  setTimeRange: (preset: TimeRangePreset) => void;
  setOnlyFailures: (only: boolean) => void;
  setProject: (project: string | null) => void;
  resetFilters: () => void;
  getDateRange: () => { start: string; end: string };
}

const FilterContext = createContext<FilterContextValue | null>(null);

function getPresetDateRange(preset: TimeRangePreset): { start: string; end: string } {
  const now = new Date();
  const end = now.toISOString();
  let start: Date;

  switch (preset) {
    case '24h':
      start = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      break;
    case '7d':
      start = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      break;
    case '30d':
      start = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      break;
    default:
      start = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  }

  return { start: start.toISOString(), end };
}

export function FilterProvider({ children }: { children: ReactNode }) {
  const [filters, setFilters] = useState<DashboardFilters>(DEFAULT_FILTERS);

  const setTimeRange = useCallback((preset: TimeRangePreset) => {
    setFilters(prev => ({ ...prev, timeRange: preset }));
  }, []);

  const setOnlyFailures = useCallback((onlyFailures: boolean) => {
    setFilters(prev => ({ ...prev, onlyFailures }));
  }, []);

  const setProject = useCallback((project: string | null) => {
    setFilters(prev => ({ ...prev, project }));
  }, []);

  const resetFilters = useCallback(() => {
    setFilters(DEFAULT_FILTERS);
  }, []);

  const getDateRange = useCallback(() => {
    if (filters.timeRange === 'custom' && filters.startDate && filters.endDate) {
      return { start: filters.startDate, end: filters.endDate };
    }
    return getPresetDateRange(filters.timeRange);
  }, [filters]);

  const value = useMemo(() => ({
    filters,
    setTimeRange,
    setOnlyFailures,
    setProject,
    resetFilters,
    getDateRange,
  }), [filters, setTimeRange, setOnlyFailures, setProject, resetFilters, getDateRange]);

  return (
    <FilterContext.Provider value={value}>
      {children}
    </FilterContext.Provider>
  );
}

export function useFilters() {
  const context = useContext(FilterContext);
  if (!context) {
    throw new Error('useFilters must be used within a FilterProvider');
  }
  return context;
}
