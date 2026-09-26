import { Activity, CheckCircle, AlertCircle } from 'lucide-react';
import { useTelemetryMetrics } from '../../hooks/useTelemetryMetrics';
import { MetricCard } from './MetricCard';
import { MetricGrid } from './MetricGrid';

function computeSuccessRate(eventsByType: Record<string, number>): number {
  const completed = eventsByType['exec.complete'] ?? 0;
  const failed = eventsByType['exec.failed'] ?? 0;
  const total = completed + failed;
  if (total === 0) return 100;
  return (completed / total) * 100;
}

export function DashboardMetrics() {
  const { data, isLoading, error } = useTelemetryMetrics();

  if (isLoading) {
    return (
      <MetricGrid>
        {[1, 2, 3, 4].map((i) => (
          <div key={i} className="h-24 bg-slate-100 animate-pulse rounded-2xl" />
        ))}
      </MetricGrid>
    );
  }

  if (error || !data) {
    return <div className="text-red-500">Failed to load metrics</div>;
  }

  const successRate = computeSuccessRate(data.eventsByType ?? {});

  return (
    <MetricGrid>
      <MetricCard
        title="Total Events"
        value={data.totalEvents?.toLocaleString() ?? '0'}
        icon={Activity}
      />
      <MetricCard
        title="Success Rate"
        value={`${successRate.toFixed(1)}%`}
        icon={CheckCircle}
        variant={successRate > 90 ? 'success' : successRate > 70 ? 'warning' : 'danger'}
      />
      <MetricCard
        title="Exec Runs"
        value={data.eventsByType?.['exec.start'] ?? 0}
        icon={Activity}
      />
      <MetricCard
        title="Failures"
        value={data.eventsByType?.['exec.failed'] ?? 0}
        icon={AlertCircle}
        variant={(data.eventsByType?.['exec.failed'] ?? 0) > 0 ? 'danger' : 'default'}
      />
    </MetricGrid>
  );
}
