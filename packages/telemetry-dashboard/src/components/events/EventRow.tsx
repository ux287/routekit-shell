import { ChevronDown, ChevronRight } from 'lucide-react';
import { TelemetryEvent } from '../../lib/types';
import { formatLocalDatetime } from '../../lib/format';

interface EventRowProps {
  event: TelemetryEvent;
  isExpanded: boolean;
  onToggle: () => void;
}

function getEventType(event: TelemetryEvent): string {
  return event.type || (event as any).event || '';
}

function getStatusColor(event: TelemetryEvent) {
  const t = getEventType(event);
  if (t.includes('failed')) return 'bg-red-100 text-red-700';
  if (t.includes('complete') || t.includes('success')) return 'bg-emerald-100 text-emerald-700';
  return 'bg-slate-100 text-slate-700';
}

export function EventRow({ event, isExpanded, onToggle }: EventRowProps) {
  const Icon = isExpanded ? ChevronDown : ChevronRight;

  return (
    <div className="border-b border-slate-100">
      <button
        onClick={onToggle}
        className="w-full px-4 py-3 flex items-center gap-4 hover:bg-slate-50 text-left cursor-pointer"
      >
        <Icon className="h-4 w-4 text-slate-400 flex-shrink-0" />
        <time className="text-sm text-slate-500 font-mono w-44 flex-shrink-0">
          {formatLocalDatetime(event.timestamp)}
        </time>
        <span className={`px-2 py-0.5 rounded text-xs font-medium ${getStatusColor(event)}`}>
          {getEventType(event) || 'unknown'}
        </span>
        <span className="flex-1 truncate text-sm text-slate-700">
          {(event.payload as any)?.label || (event.payload as any)?.slug || (event.payload as any)?.tool || '—'}
        </span>
      </button>
      {isExpanded && (
        <div className="px-4 py-3 bg-slate-50 border-t border-slate-100">
          <pre className="text-xs text-slate-600 overflow-x-auto">
            {JSON.stringify(event.payload ?? event.context ?? {}, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}