import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, CheckCircle, XCircle, Clock } from 'lucide-react';
import { useState } from 'react';
import { fetchStoriesActivity } from '../../lib/api';
import { useFilters } from '../../lib/FilterContext';
import { StoryActivity } from '../../lib/types';
import { Card, CardHeader, CardContent } from '../ui/card';

function formatTimestamp(ts: string) {
  if (!ts) return '—';
  return new Date(ts).toLocaleString();
}

function StoryRow({ story }: { story: StoryActivity }) {
  const [expanded, setExpanded] = useState(false);
  const Icon = expanded ? ChevronDown : ChevronRight;

  const successRate = story.execCount > 0
    ? Math.round((story.execSuccess / story.execCount) * 100)
    : null;

  return (
    <div className="border-b border-slate-100 last:border-b-0">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full px-4 py-3 flex items-center gap-4 hover:bg-slate-50 text-left cursor-pointer"
      >
        <Icon className="h-4 w-4 text-slate-400 flex-shrink-0" />
        <span className="font-mono text-sm text-slate-700 flex-1 truncate">
          {story.problemId}
        </span>
        <span className="text-sm text-slate-500 w-20 text-right">
          {story.eventCount} events
        </span>
        {successRate !== null && (
          <span className={`text-xs px-2 py-0.5 rounded ${
            successRate >= 80 ? 'bg-emerald-100 text-emerald-700' :
            successRate >= 50 ? 'bg-amber-100 text-amber-700' :
            'bg-red-100 text-red-700'
          }`}>
            {successRate}% success
          </span>
        )}
        <time className="text-xs text-slate-400 w-36 text-right">
          {formatTimestamp(story.lastActivity)}
        </time>
      </button>
      {expanded && (
        <div className="px-4 py-3 bg-slate-50 border-t border-slate-100">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
            <div>
              <span className="text-slate-500">Event Types:</span>
              <div className="flex flex-wrap gap-1 mt-1">
                {story.eventTypes.map(type => (
                  <span key={type} className="px-2 py-0.5 bg-slate-200 text-slate-700 rounded text-xs">
                    {type}
                  </span>
                ))}
              </div>
            </div>
            <div className="flex items-center gap-2">
              <CheckCircle className="h-4 w-4 text-emerald-500" />
              <span>{story.execSuccess} successful</span>
            </div>
            <div className="flex items-center gap-2">
              <XCircle className="h-4 w-4 text-red-500" />
              <span>{story.execFailed} failed</span>
            </div>
            <div className="flex items-center gap-2">
              <Clock className="h-4 w-4 text-slate-400" />
              <span>{story.execCount} total runs</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export function StoryActivityTable() {
  const { filters } = useFilters();
  const project = filters.project;
  const { data, isLoading, error } = useQuery({
    queryKey: ['telemetry', 'by-story', project],
    queryFn: () => fetchStoriesActivity({ project }),
    refetchInterval: 30000,
  });

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <h2 className="text-lg font-semibold">Activity by Story</h2>
        </CardHeader>
        <CardContent>
          <div className="animate-pulse space-y-2">
            {[1, 2, 3].map(i => (
              <div key={i} className="h-12 bg-slate-100 rounded" />
            ))}
          </div>
        </CardContent>
      </Card>
    );
  }

  if (error) {
    return (
      <Card>
        <CardHeader>
          <h2 className="text-lg font-semibold">Activity by Story</h2>
        </CardHeader>
        <CardContent>
          <div className="text-red-500">Error loading story activity</div>
        </CardContent>
      </Card>
    );
  }

  const stories: StoryActivity[] = data?.stories || [];

  return (
    <Card>
      <CardHeader>
        <h2 className="text-lg font-semibold">Activity by Story ({stories.length})</h2>
      </CardHeader>
      <CardContent className="p-0">
        {stories.length === 0 ? (
          <div className="p-4 text-center text-slate-400">No story activity found</div>
        ) : (
          <div className="divide-y divide-slate-100">
            {stories.slice(0, 20).map(story => (
              <StoryRow key={story.problemId} story={story} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
