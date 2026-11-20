import { useQuery } from '@tanstack/react-query';
import { Clock } from 'lucide-react';
import { fetchLatency } from '../../lib/api';
import { useFilters } from '../../lib/FilterContext';
import { Card, CardHeader, CardContent } from '../ui/card';
import { LatencyOperation } from '../../lib/types';

interface LatencyChartProps {
  startDate?: string | null;
  endDate?: string | null;
  type?: string | null;
}

export function LatencyChart({ startDate, endDate, type }: LatencyChartProps = {}) {
  const { filters } = useFilters();
  const project = filters.project;
  const { data, isLoading } = useQuery({
    queryKey: ['telemetry', 'latency', startDate, endDate, type, project],
    queryFn: () => fetchLatency({ startDate, endDate, type, project }),
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

  const operations: LatencyOperation[] = data?.operations || [];

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center gap-2">
          <Clock className="h-5 w-5 text-slate-600" />
          <h3 className="font-semibold">Latency Analysis</h3>
        </div>
      </CardHeader>
      <CardContent>
        {operations.length === 0 ? (
          <div className="text-center text-slate-400 py-4">No latency data available</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-slate-500 border-b">
                  <th className="pb-2">Operation</th>
                  <th className="pb-2 text-right">Count</th>
                  <th className="pb-2 text-right">Avg</th>
                  <th className="pb-2 text-right">P95</th>
                  <th className="pb-2 text-right">Max</th>
                </tr>
              </thead>
              <tbody>
                {operations.slice(0, 10).map((op) => (
                  <tr key={op.operation} className="border-b border-slate-50">
                    <td className="py-2 font-mono">{op.operation}</td>
                    <td className="py-2 text-right">{op.count}</td>
                    <td className="py-2 text-right">{op.avg}ms</td>
                    <td className="py-2 text-right">{op.p95}ms</td>
                    <td className="py-2 text-right text-slate-400">{op.max}ms</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}