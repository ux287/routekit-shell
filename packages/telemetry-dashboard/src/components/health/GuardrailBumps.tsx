import { useQuery } from '@tanstack/react-query';
import { AlertTriangle } from 'lucide-react';
import { fetchGuardrailEvents } from '../../lib/api';
import { useFilters } from '../../lib/FilterContext';
import { Card, CardHeader, CardContent } from '../ui/card';
import type { GuardrailEvent } from '../../lib/types';

/** chain.violation execution-path context: blockedTool, flowType→state, violationKind, expectedTools. */
function chainContext(p: Record<string, unknown>): string {
  const parts: string[] = [];
  if (p.blockedTool) parts.push(`blocked: ${String(p.blockedTool)}`);
  if (p.flowType || p.state) parts.push(`${String(p.flowType ?? '?')}→${String(p.state ?? '?')}`);
  if (p.violationKind) parts.push(String(p.violationKind));
  if (Array.isArray(p.expectedTools) && p.expectedTools.length) {
    parts.push(`expected: ${(p.expectedTools as unknown[]).join(', ')}`);
  }
  return parts.join(' · ');
}

/** hook.guardrail_bump execution-path context: hookName, blockedTool, redirectAgent, reason. */
function bumpContext(p: Record<string, unknown>): string {
  const parts: string[] = [];
  if (p.hookName) parts.push(String(p.hookName));
  if (p.blockedTool) parts.push(`blocked: ${String(p.blockedTool)}`);
  if (p.redirectAgent) parts.push(`→ ${String(p.redirectAgent)}`);
  if (p.reason) parts.push(String(p.reason));
  return parts.join(' · ');
}

export function GuardrailBumps() {
  const { filters } = useFilters();
  const project = filters.project;
  const { data, isLoading } = useQuery({
    queryKey: ['telemetry', 'guardrail-events', project],
    queryFn: () => fetchGuardrailEvents({ project }),
    refetchInterval: 30000,
  });

  if (isLoading) {
    return (
      <Card>
        <CardContent className="p-6">
          <div className="animate-pulse h-32 bg-slate-100 rounded" data-testid="guardrail-bumps-loading" />
        </CardContent>
      </Card>
    );
  }

  const events: GuardrailEvent[] = data?.events ?? [];
  const chainViolations = events.filter((e) => e.type === 'chain.violation').length;
  const guardrailBumps = events.filter((e) => e.type === 'hook.guardrail_bump').length;

  return (
    <Card data-testid="guardrail-bumps">
      <CardHeader className="flex flex-row items-center space-y-0 pb-2">
        <div className="flex items-center gap-2">
          <AlertTriangle className="h-4 w-4" />
          <h3 className="text-lg font-semibold">Guardrail Bumps &amp; Chain Violations</h3>
        </div>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 gap-4 mb-4">
          <div className="flex items-center gap-2">
            <div className="text-2xl font-bold text-red-500" data-testid="chain-violations-count">{chainViolations}</div>
            <span className="text-sm text-gray-600">Chain Violations</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="text-2xl font-bold text-amber-500" data-testid="guardrail-bumps-count">{guardrailBumps}</div>
            <span className="text-sm text-gray-600">Guardrail Bumps</span>
          </div>
        </div>
        {events.length === 0 ? (
          <div className="text-sm text-gray-500" data-testid="guardrail-bumps-empty">
            No chain violations or guardrail bumps recorded.
          </div>
        ) : (
          <ul className="space-y-2" data-testid="guardrail-bumps-list">
            {events.map((e, i) => {
              const p = (e.payload || {}) as Record<string, unknown>;
              const ctx = e.type === 'chain.violation' ? chainContext(p) : bumpContext(p);
              return (
                <li
                  key={e.id ?? i}
                  className="text-sm border-l-2 pl-2 border-slate-200"
                  data-testid="guardrail-event-row"
                >
                  <span className="font-mono text-xs text-gray-500">{e.type}</span>
                  <span className="ml-2">{ctx}</span>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
