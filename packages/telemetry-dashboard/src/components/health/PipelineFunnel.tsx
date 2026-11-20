import { useQuery } from '@tanstack/react-query';
import { GitBranch } from 'lucide-react';
import { fetchPipeline } from '../../lib/api';
import { useFilters } from '../../lib/FilterContext';
import { Card, CardHeader, CardContent } from '../ui/card';

interface PipelineFunnelProps {
  startDate?: string | null;
  endDate?: string | null;
  type?: string | null;
}

export function PipelineFunnel({ startDate, endDate, type }: PipelineFunnelProps = {}) {
  const { filters } = useFilters();
  const project = filters.project;
  const { data, isLoading } = useQuery({
    queryKey: ['telemetry', 'pipeline', startDate, endDate, type, project],
    queryFn: () => fetchPipeline({ startDate, endDate, type, project }),
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

  const { planned = 0, executed = 0, shipped = 0, execRate = 0, shipRate = 0 } = data || {};

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center gap-2">
          <GitBranch className="h-5 w-5 text-slate-600" />
          <h3 className="font-semibold">Pipeline Funnel</h3>
        </div>
      </CardHeader>
      <CardContent>
        <div className="space-y-3">
          <div className="flex items-center gap-3">
            <div className="w-20 text-sm text-slate-600">Planned</div>
            <div className="flex-1 bg-slate-100 rounded-full h-6 relative">
              <div className="bg-blue-500 h-6 rounded-full" style={{ width: '100%' }} />
              <span className="absolute inset-0 flex items-center justify-center text-xs font-medium text-white">{planned}</span>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <div className="w-20 text-sm text-slate-600">Executed</div>
            <div className="flex-1 bg-slate-100 rounded-full h-6 relative">
              <div className="bg-indigo-500 h-6 rounded-full" style={{ width: `${Math.min(execRate, 100)}%` }} />
              <span className="absolute inset-0 flex items-center justify-center text-xs font-medium">{executed} ({execRate}%)</span>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <div className="w-20 text-sm text-slate-600">Shipped</div>
            <div className="flex-1 bg-slate-100 rounded-full h-6 relative">
              <div className="bg-emerald-500 h-6 rounded-full" style={{ width: `${Math.min(shipRate, 100)}%` }} />
              <span className="absolute inset-0 flex items-center justify-center text-xs font-medium">{shipped} ({shipRate}%)</span>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}