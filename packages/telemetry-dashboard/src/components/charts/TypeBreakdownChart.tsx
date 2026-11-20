import { PieChart, Pie, Cell, ResponsiveContainer, Legend, Tooltip } from 'recharts';
import { Card, CardHeader, CardContent } from '../ui/card';
import { useTelemetryMetrics } from '../../hooks/useTelemetryMetrics';

const COLORS = ['#6366f1', '#8b5cf6', '#10b981', '#f59e0b', '#3b82f6', '#ec4899', '#94a3b8'];

export function TypeBreakdownChart() {
  const { data, isLoading } = useTelemetryMetrics();

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <h3 className="font-semibold">Events by Type</h3>
        </CardHeader>
        <CardContent>
          <div className="h-64 bg-slate-100 animate-pulse rounded" />
        </CardContent>
      </Card>
    );
  }

  const eventsByType = data?.eventsByType ?? {};
  
  // Group by category prefix
  const categories: Record<string, number> = {};
  for (const [type, count] of Object.entries(eventsByType)) {
    const category = type.split('.')[0];
    categories[category] = (categories[category] || 0) + (count as number);
  }

  const chartData = Object.entries(categories)
    .map(([name, value]) => ({ name, value }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 7);

  if (chartData.length === 0) {
    return (
      <Card>
        <CardHeader>
          <h3 className="font-semibold">Events by Category</h3>
        </CardHeader>
        <CardContent>
          <div className="h-64 flex items-center justify-center text-slate-400">
            No events to display
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <h3 className="font-semibold">Events by Category</h3>
      </CardHeader>
      <CardContent>
        <ResponsiveContainer width="100%" height={300}>
          <PieChart>
            <Pie
              data={chartData}
              dataKey="value"
              nameKey="name"
              cx="50%"
              cy="50%"
              innerRadius={60}
              outerRadius={100}
              label={({ name, percent }) => `${name} (${(percent * 100).toFixed(0)}%)`}
            >
              {chartData.map((_, index) => (
                <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
              ))}
            </Pie>
            <Tooltip />
            <Legend />
          </PieChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  );
}