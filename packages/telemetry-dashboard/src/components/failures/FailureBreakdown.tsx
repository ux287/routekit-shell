import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, Clock } from 'lucide-react';
import { useFilters } from '../../lib/FilterContext';
import { Card, CardHeader, CardContent } from '../ui/card';
import { formatLocalDatetime } from '../../lib/format';

interface FailureData {
  total: number;
  byLocation: Array<{ location: string; count: number }>;
  topReasons: Array<{ reason: string; count: number }>;
  lastFailure: {
    timestamp: string;
    type: string;
    reason: string;
    location: string;
  } | null;
}

async function fetchFailures(filters: { startDate?: string | null; endDate?: string | null; type?: string | null; project?: string | null } = {}): Promise<FailureData> {
  const params = new URLSearchParams();
  if (filters.startDate) params.set('startDate', filters.startDate);
  if (filters.endDate) params.set('endDate', filters.endDate);
  if (filters.type) params.set('type', filters.type);
  if (filters.project) params.set('project', filters.project);

  const url = `/api/telemetry/failures${params.toString() ? '?' + params.toString() : ''}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('Failed to fetch failures');
  return res.json();
}

const locationColors: Record<string, string> = {
  plan: 'bg-blue-500',
  exec: 'bg-indigo-500',
  validate: 'bg-amber-500',
  ship: 'bg-emerald-500',
  mcp: 'bg-purple-500',
  guardrails: 'bg-red-500',
  unknown: 'bg-slate-400',
};

interface FailureBreakdownProps {
  startDate?: string | null;
  endDate?: string | null;
  type?: string | null;
}

export function FailureBreakdown({ startDate, endDate, type }: FailureBreakdownProps = {}) {
  const { filters } = useFilters();
  const project = filters.project;
  const { data, isLoading } = useQuery({
    queryKey: ['telemetry', 'failures', startDate, endDate, type, project],
    queryFn: () => fetchFailures({ startDate, endDate, type, project }),
    refetchInterval: 30000,
  });

  if (isLoading) {
    return (
      <Card>
        <CardContent className="p-6">
          <div className="animate-pulse h-48 bg-slate-100 rounded" />
        </CardContent>
      </Card>
    );
  }

  const { total = 0, byLocation = [], topReasons = [], lastFailure } = data || {};

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-red-500" />
            <h3 className="font-semibold">Failure Breakdown</h3>
          </div>
          <span className="text-2xl font-bold text-red-600">{total}</span>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div>
          <h4 className="text-sm font-medium text-slate-600 mb-2">By Location</h4>
          <div className="flex gap-1 h-4 rounded overflow-hidden">
            {byLocation.map(({ location, count }) => (
              <div
                key={location}
                className={`${locationColors[location] || locationColors.unknown}`}
                style={{ width: `${(count / total) * 100}%` }}
                title={`${location}: ${count}`}
              />
            ))}
          </div>
          <div className="flex flex-wrap gap-2 mt-2 text-xs">
            {byLocation.slice(0, 4).map(({ location, count }) => (
              <span key={location} className="flex items-center gap-1">
                <span className={`w-2 h-2 rounded ${locationColors[location] || locationColors.unknown}`} />
                {location}: {count}
              </span>
            ))}
          </div>
        </div>

        {topReasons.length > 0 && (
          <div>
            <h4 className="text-sm font-medium text-slate-600 mb-2">Top Reasons</h4>
            <div className="space-y-1">
              {topReasons.slice(0, 5).map(({ reason, count }, i) => (
                <div key={i} className="flex justify-between text-sm">
                  <span className="text-slate-700 truncate flex-1 mr-2">{reason}</span>
                  <span className="text-slate-500 tabular-nums">{count}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {lastFailure && (
          <div className="pt-2 border-t">
            <h4 className="text-sm font-medium text-slate-600 mb-1 flex items-center gap-1">
              <Clock className="h-3 w-3" />
              Last Failure
            </h4>
            <div className="text-sm">
              <span className="text-slate-500">{formatLocalDatetime(lastFailure.timestamp)}</span>
              <span className="mx-1">·</span>
              <span className={`px-1.5 py-0.5 rounded text-xs ${locationColors[lastFailure.location]} text-white`}>
                {lastFailure.location}
              </span>
              <p className="text-slate-700 mt-1 truncate">{lastFailure.reason}</p>
            </div>
          </div>
        )}

        {total === 0 && (
          <div className="text-center text-slate-400 py-4">No failures recorded</div>
        )}
      </CardContent>
    </Card>
  );
}