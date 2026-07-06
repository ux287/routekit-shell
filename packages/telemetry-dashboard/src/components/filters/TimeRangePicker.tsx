import { Clock } from 'lucide-react';
import { useFilters } from '../../lib/FilterContext';
import { TimeRangePreset } from '../../lib/types';

const presets: { value: TimeRangePreset; label: string }[] = [
  { value: '24h', label: '24h' },
  { value: '7d', label: '7d' },
  { value: '30d', label: '30d' },
];

export function TimeRangePicker() {
  const { filters, setTimeRange } = useFilters();

  return (
    <div className="flex items-center gap-2">
      <Clock className="h-4 w-4 text-slate-500" />
      <div className="flex rounded-md border border-slate-200 overflow-hidden">
        {presets.map(({ value, label }) => (
          <button
            key={value}
            onClick={() => setTimeRange(value)}
            className={`px-3 py-1.5 text-sm font-medium transition-colors ${
              filters.timeRange === value
                ? 'bg-blue-600 text-white'
                : 'bg-white text-slate-600 hover:bg-slate-50'
            }`}
          >
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}