import { useState } from 'react';
import { Card, CardHeader, CardContent } from '../ui/card';
import { useTelemetryEvents } from '../../hooks/useTelemetryEvents';
import { EventRow } from './EventRow';

interface EventTimelineProps {
  startDate?: string | null;
  endDate?: string | null;
  type?: string | null;
}

export function EventTimeline({ startDate, endDate, type }: EventTimelineProps = {}) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const { data, isLoading, error } = useTelemetryEvents({ 
    limit: 50, 
    startDate: startDate ?? undefined, 
    endDate: endDate ?? undefined, 
    type: type ?? undefined 
  });

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <h2 className="text-lg font-semibold">Recent Events</h2>
        </CardHeader>
        <CardContent className="p-0">
          {[1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="h-12 bg-slate-100 animate-pulse border-b border-slate-200" />
          ))}
        </CardContent>
      </Card>
    );
  }

  if (error) {
    return <div className="text-red-500">Failed to load events</div>;
  }

  const events = data?.events ?? [];

  return (
    <Card>
      <CardHeader>
        <h2 className="text-lg font-semibold">Recent Events ({events.length})</h2>
      </CardHeader>
      <CardContent className="p-0 max-h-[500px] overflow-y-auto">
        {events.map((event, index) => {
          const eventKey = event.id || `${event.timestamp}-${index}`;
          return (
            <EventRow
              key={eventKey}
              event={event}
              isExpanded={expandedId === eventKey}
              onToggle={() => setExpandedId((prev) => (prev === eventKey ? null : eventKey))}
            />
          );
        })}
      </CardContent>
    </Card>
  );
}