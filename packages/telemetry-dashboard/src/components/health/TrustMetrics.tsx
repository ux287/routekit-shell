import { useQuery } from '@tanstack/react-query';
import { Shield } from 'lucide-react';
import { fetchTrust } from '../../lib/api';
import { useFilters } from '../../lib/FilterContext';
import { Card, CardHeader, CardContent } from '../ui/card';

interface TrustMetricsProps {
  startDate?: string | null;
  endDate?: string | null;
  type?: string | null;
}

export function TrustMetrics({ startDate, endDate, type }: TrustMetricsProps = {}) {
  const { filters } = useFilters();
  const project = filters.project;
  const { data, isLoading } = useQuery({
    queryKey: ['telemetry', 'trust', startDate, endDate, type, project],
    queryFn: () => fetchTrust({ startDate, endDate, type, project }),
    refetchInterval: 30000,
  });

  if (isLoading) {
    return (
      <Card>
        <CardContent className="p-6">
          <div className="animate-pulse h-32 bg-slate-100 rounded" />
        </CardContent>
      </Card>
    );
  }

  const {
    trustScore = 100,
    guardrailsTriggered = 0,
    guardrailsPassed = 0,
    offRailSessions = 0,
    hooksBlocked = 0,
    hooksAllowed = 0
  } = data || {};

  const scoreColor = trustScore >= 80 ? 'text-emerald-500'
    : trustScore >= 50 ? 'text-amber-500' : 'text-red-500';

  return (
    <Card>
      <CardHeader className="flex flex-row items-center space-y-0 pb-2">
        <div className="flex items-center gap-2">
          <Shield className="h-4 w-4" />
          <h3 className="text-lg font-semibold">Trust Metrics</h3>
        </div>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 gap-4">
          <div className="flex items-center gap-2">
            <div className={`text-2xl font-bold ${scoreColor}`}>{trustScore}</div>
            <span className="text-sm text-gray-600">Trust Score</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 rounded-full bg-green-500" />
            <span>Guardrails Checked: {guardrailsPassed}</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 rounded-full bg-red-500" />
            <span>Guardrails Blocked: {guardrailsTriggered}</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 rounded-full bg-orange-500" />
            <span>Off-rail Sessions: {offRailSessions}</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 rounded-full bg-amber-500" />
            <span>Hook Blocks: {hooksBlocked}</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 rounded-full bg-emerald-500" />
            <span>Hook Passes: {hooksAllowed}</span>
          </div>
        </div>
      </CardContent>
    </Card>
  );
};