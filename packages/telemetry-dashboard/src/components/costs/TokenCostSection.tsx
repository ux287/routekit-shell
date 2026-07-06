import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import { useTokenCosts } from '../../hooks/useTelemetryMetrics';
import { Card, CardHeader, CardContent } from '../ui/card';
import type { StoryCostData, DailySeriesEntry } from '../../lib/api';

function HealthBadge({ band }: { band: 'green' | 'yellow' | 'red' }) {
  const cls =
    band === 'green' ? 'bg-green-100 text-green-800' :
    band === 'yellow' ? 'bg-yellow-100 text-yellow-800' :
    'bg-red-100 text-red-800';
  return <span className={`px-2 py-0.5 rounded text-xs font-medium ${cls}`}>{band}</span>;
}

function CacheRatioBar({ ratio }: { ratio: number }) {
  const pct = Math.round(ratio * 100);
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-xs text-slate-600">
        <span>Cache-hit ratio</span>
        <span>{pct}%</span>
      </div>
      <div className="h-2 bg-slate-100 rounded-full overflow-hidden">
        <div className="h-full bg-blue-400 rounded-full" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

export function TokenCostSection() {
  const { data, isLoading, isError } = useTokenCosts();

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <h2 className="text-lg font-semibold">Token Cost &amp; Efficiency</h2>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-center h-40">
            <div className="animate-spin h-6 w-6 border-2 border-slate-300 border-t-blue-500 rounded-full" />
          </div>
        </CardContent>
      </Card>
    );
  }

  if (isError) {
    return (
      <Card>
        <CardHeader>
          <h2 className="text-lg font-semibold">Token Cost &amp; Efficiency</h2>
        </CardHeader>
        <CardContent>
          <div className="text-red-500">Error loading token cost data</div>
        </CardContent>
      </Card>
    );
  }

  const dailySeries: DailySeriesEntry[] = data?.dailySeries || [];
  const stories: StoryCostData[] = data?.stories || [];

  if (dailySeries.length === 0) {
    return (
      <Card>
        <CardHeader>
          <h2 className="text-lg font-semibold">Token Cost &amp; Efficiency</h2>
        </CardHeader>
        <CardContent>
          <div className="text-center text-slate-400 py-8">No token data available</div>
        </CardContent>
      </Card>
    );
  }

  const activeDays = dailySeries.filter(d => !d.noData);
  const avgCacheRatio = activeDays.length > 0
    ? activeDays.reduce((sum, d) => sum + d.cacheRatio, 0) / activeDays.length
    : 0;

  const chartData = dailySeries.map(d => ({
    date: d.date.slice(5),
    rawCost: d.noData ? 0 : d.rawCost,
    noData: d.noData,
  }));

  return (
    <Card>
      <CardHeader>
        <h2 className="text-lg font-semibold">Token Cost &amp; Efficiency</h2>
      </CardHeader>
      <CardContent className="space-y-6">
        <div>
          <h3 className="text-sm font-medium text-slate-600 mb-2">Daily token spend (14 days)</h3>
          <ResponsiveContainer width="100%" height={160}>
            <BarChart data={chartData} margin={{ top: 4, right: 4, bottom: 4, left: 4 }}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e2e8f0" />
              <XAxis dataKey="date" tick={{ fontSize: 10 }} />
              <YAxis tick={{ fontSize: 10 }} />
              <Tooltip formatter={(val) => [Number(val).toLocaleString(), 'Tokens']} />
              <Bar dataKey="rawCost" fill="#6366f1" radius={[2, 2, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>

        <CacheRatioBar ratio={avgCacheRatio} />

        {stories.length > 0 && (
          <div>
            <h3 className="text-sm font-medium text-slate-600 mb-2">Cost by story</h3>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-slate-500 border-b border-slate-100">
                    <th className="pb-2 pr-4">Story</th>
                    <th className="pb-2 pr-4 text-right">Tokens</th>
                    <th className="pb-2 pr-4 text-right">Waste</th>
                    <th className="pb-2">Health</th>
                  </tr>
                </thead>
                <tbody>
                  {stories.slice(0, 10).map(story => (
                    <tr key={story.storyId} className="border-b border-slate-50 last:border-0">
                      <td className="py-2 pr-4 font-mono text-xs text-slate-700 truncate max-w-xs">
                        {story.storyId}
                      </td>
                      <td className="py-2 pr-4 text-right tabular-nums">
                        {story.rawCost.toLocaleString()}
                      </td>
                      <td className="py-2 pr-4 text-right tabular-nums text-slate-500">
                        {Math.round(story.wasteRatio * 100)}%
                      </td>
                      <td className="py-2">
                        <HealthBadge band={story.healthBand} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
