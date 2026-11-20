import { useQuery } from '@tanstack/react-query';
import { Activity, CheckCircle, AlertTriangle, XCircle } from 'lucide-react';
import { fetchHealth } from '../../lib/api';
import { useFilters } from '../../lib/FilterContext';
import { Card, CardHeader, CardContent } from '../ui/card';

interface HealthStatusProps {
  startDate?: string | null;
  endDate?: string | null;
  type?: string | null;
}

export function HealthStatus({ startDate, endDate, type }: HealthStatusProps = {}) {
  const { filters } = useFilters();
  const project = filters.project;
  const { data, isLoading } = useQuery({
    queryKey: ['telemetry', 'health', startDate, endDate, type, project],
    queryFn: () => fetchHealth({ startDate, endDate, type, project }),
    refetchInterval: 30000,
  });

  if (isLoading) {
    return (
      <Card>
        <CardContent className="p-6">
          <div className="animate-pulse h-20 bg-slate-100 rounded" />
        </CardContent>
      </Card>
    );
  }

  const status = data?.status || 'unknown';
  const score = data?.score || 0;

  const StatusIcon = status === 'healthy' ? CheckCircle 
    : status === 'degraded' ? AlertTriangle : XCircle;
  
  const statusColor = status === 'healthy' ? 'text-emerald-500' 
    : status === 'degraded' ? 'text-amber-500' : 'text-red-500';
  
  const bgColor = status === 'healthy' ? 'bg-emerald-50' 
    : status === 'degraded' ? 'bg-amber-50' : 'bg-red-50';

  return (
    <Card className={bgColor}>
      <CardHeader className="pb-2">
        <div className="flex items-center gap-2">
          <Activity className="h-5 w-5 text-slate-600" />
          <h3 className="font-semibold">System Health</h3>
        </div>
      </CardHeader>
      <CardContent>
        <div className="flex items-center gap-4">
          <StatusIcon className={`h-12 w-12 ${statusColor}`} />
          <div>
            <div className={`text-2xl font-bold ${statusColor}`}>
              {status.charAt(0).toUpperCase() + status.slice(1)}
            </div>
            <div className="text-sm text-slate-600">Score: {score}/100</div>
          </div>
        </div>
        {data?.details && (
          <div className="mt-4 grid grid-cols-2 gap-2 text-sm">
            <div>Events (24h): {data.details.totalEvents}</div>
            <div>Error rate: {data.details.errorRate}%</div>
            <div>Exec success: {data.details.execSuccessRate}%</div>
            <div>Errors: {data.details.errorEvents}</div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}