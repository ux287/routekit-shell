import { Plugin } from 'vite';
import { readdir, readFile } from 'fs/promises';
import { join, resolve } from 'path';
import { existsSync, readFileSync } from 'fs';

interface ProjectEntry {
  id: string;
  root: string;
  telemetryDir: string;
}

/** Build a map of projectId -> telemetry directory from the registry + self */
function loadProjectMap(repoRoot: string): Map<string, ProjectEntry> {
  const map = new Map<string, ProjectEntry>();

  // Self project (routekit-shell) — always present
  const selfTelemetry = join(repoRoot, '.rks', 'telemetry');
  const selfProjectJsonPath = join(repoRoot, '.rks', 'project.json');
  let selfId = 'routekit-shell';
  if (existsSync(selfProjectJsonPath)) {
    try {
      const pj = JSON.parse(readFileSync(selfProjectJsonPath, 'utf-8'));
      if (pj.id) selfId = pj.id;
    } catch { /* use default */ }
  }
  map.set(selfId, { id: selfId, root: repoRoot, telemetryDir: selfTelemetry });

  // Registered projects from projects/index.jsonl
  const registryPath = join(repoRoot, 'projects', 'index.jsonl');
  if (existsSync(registryPath)) {
    try {
      const lines = readFileSync(registryPath, 'utf-8').split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          if (entry.id && entry.root) {
            const telDir = join(entry.root, '.rks', 'telemetry');
            map.set(entry.id, { id: entry.id, root: entry.root, telemetryDir: telDir });
          }
        } catch { /* skip malformed line */ }
      }
    } catch { /* registry unreadable */ }
  }

  return map;
}

/** Read and parse all JSONL events from a telemetry directory */
async function readAllEvents(resolvedDir: string): Promise<any[]> {
  if (!existsSync(resolvedDir)) return [];

  const files = await readdir(resolvedDir);
  const jsonlFiles = files.filter(f => f.endsWith('.jsonl')).sort().reverse();

  const events: any[] = [];
  for (const file of jsonlFiles) {
    const content = await readFile(join(resolvedDir, file), 'utf-8');
    const lines = content.trim().split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        events.push(JSON.parse(line));
      } catch {
        continue;
      }
    }
  }
  return events;
}

export function telemetryApiPlugin(telemetryDir: string = '.rks/telemetry'): Plugin {
  return {
    name: 'telemetry-api',
    configureServer(server) {
      // Repo root is two levels up from packages/telemetry-dashboard
      const repoRoot = resolve(process.cwd(), '../..');

      /** Resolve telemetry dir for a project (or default) */
      function getTelemetryDir(projectId: string | null): string {
        if (!projectId) return resolve(process.cwd(), telemetryDir);
        const projectMap = loadProjectMap(repoRoot);
        const entry = projectMap.get(projectId);
        return entry ? entry.telemetryDir : resolve(process.cwd(), telemetryDir);
      }

      /** Extract project query param from URL */
      function getProjectFilter(url: URL): string | null {
        return url.searchParams.get('project');
      }

      // Handle /api/telemetry/projects endpoint — list registered projects
      server.middlewares.use('/api/telemetry/projects', async (_req, res) => {
        try {
          const projectMap = loadProjectMap(repoRoot);
          // Only include projects whose telemetry dir actually exists
          const projects = Array.from(projectMap.values())
            .filter(p => existsSync(p.telemetryDir))
            .map(p => p.id)
            .sort();

          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ projects }));
        } catch (err) {
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: String(err) }));
        }
      });

      // Handle /api/telemetry/events endpoint
      server.middlewares.use('/api/telemetry/events', async (req, res) => {
        try {
          const url = new URL(req.url!, `http://${req.headers.host}`);
          const project = getProjectFilter(url);
          const type = url.searchParams.get('type');
          const limit = parseInt(url.searchParams.get('limit') || '100');
          const startDate = url.searchParams.get('startDate');
          const endDate = url.searchParams.get('endDate');

          const allEvents = await readAllEvents(getTelemetryDir(project));

          const filtered = allEvents.filter(event => {
            if (type && !(event.type?.startsWith(type) || event.event?.startsWith(type))) return false;
            if (startDate && event.timestamp && new Date(event.timestamp) < new Date(startDate)) return false;
            if (endDate && event.timestamp && new Date(event.timestamp) > new Date(endDate)) return false;
            return true;
          });

          const events = filtered
            .sort((a, b) => new Date(b.timestamp || 0).getTime() - new Date(a.timestamp || 0).getTime())
            .slice(0, limit);

          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ events, total: filtered.length }));
        } catch (err) {
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: String(err) }));
        }
      });

      // Handle /api/telemetry/by-story endpoint
      server.middlewares.use('/api/telemetry/by-story', async (req, res) => {
        try {
          const url = new URL(req.url!, `http://${req.headers.host}`);
          const project = getProjectFilter(url);

          const allEvents = await readAllEvents(getTelemetryDir(project));

          const storyMap = new Map<string, {
            problemId: string;
            eventCount: number;
            lastActivity: string;
            execCount: number;
            execSuccess: number;
            execFailed: number;
            eventTypes: Set<string>;
          }>();

          for (const event of allEvents) {
            const problemId = event.payload?.problemId || event.context?.problemId || '(off-rail)';
            const eventType = event.type || event.event || 'unknown';

            if (!storyMap.has(problemId)) {
              storyMap.set(problemId, {
                problemId,
                eventCount: 0,
                lastActivity: event.timestamp || '',
                execCount: 0,
                execSuccess: 0,
                execFailed: 0,
                eventTypes: new Set()
              });
            }

            const story = storyMap.get(problemId)!;
            story.eventCount++;
            story.eventTypes.add(eventType.split('.')[0]);

            if (event.timestamp && event.timestamp > story.lastActivity) {
              story.lastActivity = event.timestamp;
            }

            if (eventType === 'exec.complete') {
              story.execCount++;
              story.execSuccess++;
            } else if (eventType === 'exec.failed') {
              story.execCount++;
              story.execFailed++;
            }
          }

          const stories = Array.from(storyMap.values())
            .map(s => ({
              ...s,
              eventTypes: Array.from(s.eventTypes)
            }))
            .sort((a, b) => new Date(b.lastActivity).getTime() - new Date(a.lastActivity).getTime());

          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ stories }));
        } catch (err) {
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: String(err) }));
        }
      });

      // Handle /api/telemetry/report endpoint
      server.middlewares.use('/api/telemetry/report', async (req, res) => {
        try {
          const url = new URL(req.url!, `http://${req.headers.host}`);
          const project = getProjectFilter(url);

          const allEvents = await readAllEvents(getTelemetryDir(project));

          const eventsByType: Record<string, number> = {};
          for (const event of allEvents) {
            const eventType = event.type || event.event || 'unknown';
            eventsByType[eventType] = (eventsByType[eventType] || 0) + 1;
          }

          const recentActivity = allEvents
            .sort((a, b) => new Date(b.timestamp || 0).getTime() - new Date(a.timestamp || 0).getTime())
            .slice(0, 10);

          const metrics = {
            totalEvents: allEvents.length,
            eventsByType,
            recentActivity,
            trends: { daily: [], hourly: [] }
          };

          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(metrics));
        } catch (err) {
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: String(err) }));
        }
      });

      // Handle /api/telemetry/health endpoint
      server.middlewares.use('/api/telemetry/health', async (req, res) => {
        try {
          const url = new URL(req.url!, `http://${req.headers.host}`);
          const project = getProjectFilter(url);

          const allEvents = await readAllEvents(getTelemetryDir(project));

          const last24h = Date.now() - 24 * 60 * 60 * 1000;
          let totalEvents = 0;
          let errorEvents = 0;
          let execSuccess = 0;
          let execFailed = 0;

          for (const event of allEvents) {
            const eventTime = new Date(event.timestamp || 0).getTime();
            if (eventTime < last24h) continue;

            totalEvents++;
            const eventType = event.type || event.event || '';

            if (eventType.includes('error') || eventType.includes('failed')) {
              errorEvents++;
            }
            if (eventType === 'exec.complete') execSuccess++;
            if (eventType === 'exec.failed') execFailed++;
          }

          const errorRate = totalEvents > 0 ? errorEvents / totalEvents : 0;
          const execSuccessRate = (execSuccess + execFailed) > 0
            ? execSuccess / (execSuccess + execFailed) : 1;

          const score = Math.round((1 - errorRate) * 50 + execSuccessRate * 50);
          const status = score >= 80 ? 'healthy' : score >= 50 ? 'degraded' : 'unhealthy';

          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({
            status,
            score,
            details: {
              totalEvents,
              errorEvents,
              errorRate: Math.round(errorRate * 100),
              execSuccess,
              execFailed,
              execSuccessRate: Math.round(execSuccessRate * 100)
            }
          }));
        } catch (err) {
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: String(err) }));
        }
      });

      // Handle /api/telemetry/pipeline endpoint
      server.middlewares.use('/api/telemetry/pipeline', async (req, res) => {
        try {
          const url = new URL(req.url!, `http://${req.headers.host}`);
          const project = getProjectFilter(url);

          const allEvents = await readAllEvents(getTelemetryDir(project));

          let planned = 0, executed = 0, shipped = 0;

          for (const event of allEvents) {
            const eventType = event.type || event.event || '';

            if (eventType === 'plan.prompt.saved') planned++;
            if (eventType === 'exec.complete') executed++;
            if (eventType === 'story_ship.success' || eventType === 'cycle.complete') shipped++;
          }

          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({
            planned,
            executed,
            shipped,
            execRate: planned > 0 ? Math.round((executed / planned) * 100) : 0,
            shipRate: executed > 0 ? Math.round((shipped / executed) * 100) : 0
          }));
        } catch (err) {
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: String(err) }));
        }
      });

      // Handle /api/telemetry/latency endpoint
      server.middlewares.use('/api/telemetry/latency', async (req, res) => {
        try {
          const url = new URL(req.url!, `http://${req.headers.host}`);
          const project = getProjectFilter(url);

          const allEvents = await readAllEvents(getTelemetryDir(project));

          const latencyByOp: Record<string, number[]> = {};

          for (const event of allEvents) {
            const latency = event.payload?.latencyMs || event.payload?.durationMs;
            if (typeof latency !== 'number') continue;

            const eventType = event.type || event.event || 'unknown';
            const op = eventType.split('.')[0];

            if (!latencyByOp[op]) latencyByOp[op] = [];
            latencyByOp[op].push(latency);
          }

          const operations = Object.entries(latencyByOp).map(([op, values]) => {
            const sorted = values.sort((a, b) => a - b);
            return {
              operation: op,
              count: values.length,
              avg: Math.round(values.reduce((a, b) => a + b, 0) / values.length),
              p50: sorted[Math.floor(sorted.length * 0.5)] || 0,
              p95: sorted[Math.floor(sorted.length * 0.95)] || 0,
              max: sorted[sorted.length - 1] || 0
            };
          }).sort((a, b) => b.avg - a.avg);

          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ operations }));
        } catch (err) {
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: String(err) }));
        }
      });

      // Handle /api/telemetry/failures endpoint
      server.middlewares.use('/api/telemetry/failures', async (req, res) => {
        try {
          const url = new URL(req.url!, `http://${req.headers.host}`);
          const project = getProjectFilter(url);

          const allEvents = await readAllEvents(getTelemetryDir(project));

          const failures: Array<{ timestamp: string; type: string; reason: string; location: string }> = [];
          const locationCounts: Record<string, number> = {};
          const reasonCounts: Record<string, number> = {};

          for (const event of allEvents) {
            const eventType = event.type || event.event || '';

            const isFailed = eventType.includes('.failed') ||
                             eventType.includes('.error') ||
                             event.payload?.status === 'failed' ||
                             event.payload?.success === false;

            if (!isFailed) continue;

            let location = 'unknown';
            if (eventType.startsWith('plan')) location = 'plan';
            else if (eventType.startsWith('exec')) location = 'exec';
            else if (eventType.startsWith('test') || eventType.includes('validate')) location = 'validate';
            else if (eventType.startsWith('ship') || eventType.startsWith('pr')) location = 'ship';
            else if (eventType.startsWith('mcp')) location = 'mcp';
            else if (eventType.startsWith('guardrails') || eventType.startsWith('hook')) location = 'guardrails';

            const reason = event.payload?.error || event.payload?.reason || event.payload?.message || eventType;

            failures.push({
              timestamp: event.timestamp,
              type: eventType,
              reason: String(reason).slice(0, 100),
              location,
            });

            locationCounts[location] = (locationCounts[location] || 0) + 1;
            reasonCounts[reason] = (reasonCounts[reason] || 0) + 1;
          }

          failures.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

          const byLocation = Object.entries(locationCounts)
            .map(([location, count]) => ({ location, count }))
            .sort((a, b) => b.count - a.count);

          const topReasons = Object.entries(reasonCounts)
            .map(([reason, count]) => ({ reason, count }))
            .sort((a, b) => b.count - a.count)
            .slice(0, 10);

          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({
            total: failures.length,
            byLocation,
            topReasons,
            lastFailure: failures[0] || null,
          }));
        } catch (err) {
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: String(err) }));
        }
      });

      // Handle /api/telemetry/token-costs endpoint
      server.middlewares.use('/api/telemetry/token-costs', async (req, res) => {
        try {
          const url = new URL(req.url!, `http://${req.headers.host}`);
          const project = getProjectFilter(url);
          const allEvents = await readAllEvents(getTelemetryDir(project));
          const tokenEvents = allEvents.filter(ev => ev.payload?.tokens != null);

          // Per-story aggregates
          const storyMap = new Map<string, {
            storyId: string; rawCost: number; wastedCost: number;
            cacheReadTotal: number; inputTotal: number;
          }>();

          for (const ev of tokenEvents) {
            const storyId: string = ev.payload?.problemId || '(off-rail)';
            const t = ev.payload.tokens;
            const tokIn: number = t.in || 0;
            const tokOut: number = t.out || 0;
            const tokCacheRead: number = t.cacheRead || 0;
            const cost = tokIn + tokOut;
            const isWasted = (ev.type || '').includes('failed');
            if (!storyMap.has(storyId)) {
              storyMap.set(storyId, { storyId, rawCost: 0, wastedCost: 0, cacheReadTotal: 0, inputTotal: 0 });
            }
            const entry = storyMap.get(storyId)!;
            entry.rawCost += cost;
            entry.inputTotal += tokIn;
            entry.cacheReadTotal += tokCacheRead;
            if (isWasted) entry.wastedCost += cost;
          }

          const stories = Array.from(storyMap.values()).map(s => {
            const wasteRatio = s.rawCost > 0 ? s.wastedCost / s.rawCost : 0;
            const totalInput = s.inputTotal + s.cacheReadTotal;
            const cacheRatio = totalInput > 0 ? s.cacheReadTotal / totalInput : 0;
            const healthBand = wasteRatio < 0.10 ? 'green' : wasteRatio <= 0.30 ? 'yellow' : 'red';
            return { storyId: s.storyId, rawCost: s.rawCost, wasteRatio, cacheRatio, healthBand };
          }).sort((a, b) => b.rawCost - a.rawCost);

          // 14-day daily series
          const DAYS = 14;
          const dates: string[] = [];
          for (let i = DAYS - 1; i >= 0; i--) {
            const d = new Date();
            d.setDate(d.getDate() - i);
            dates.push(d.toISOString().split('T')[0]);
          }

          const byDate = new Map<string, { rawCost: number; wastedCost: number; cacheReadTotal: number; inputTotal: number }>();
          for (const date of dates) byDate.set(date, { rawCost: 0, wastedCost: 0, cacheReadTotal: 0, inputTotal: 0 });

          for (const ev of tokenEvents) {
            const evDate = ev.timestamp?.split('T')[0];
            if (!evDate || !byDate.has(evDate)) continue;
            const t = ev.payload.tokens;
            const tokIn: number = t.in || 0;
            const tokOut: number = t.out || 0;
            const tokCacheRead: number = t.cacheRead || 0;
            const cost = tokIn + tokOut;
            const isWasted = (ev.type || '').includes('failed');
            const entry = byDate.get(evDate)!;
            entry.rawCost += cost;
            entry.inputTotal += tokIn;
            entry.cacheReadTotal += tokCacheRead;
            if (isWasted) entry.wastedCost += cost;
          }

          const dailySeries = dates.map(date => {
            const d = byDate.get(date)!;
            if (d.rawCost === 0) return { date, rawCost: 0, wasteRatio: 0, cacheRatio: 0, noData: true };
            const totalInput = d.inputTotal + d.cacheReadTotal;
            return {
              date, rawCost: d.rawCost,
              wasteRatio: d.rawCost > 0 ? d.wastedCost / d.rawCost : 0,
              cacheRatio: totalInput > 0 ? d.cacheReadTotal / totalInput : 0,
              noData: false,
            };
          });

          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ stories, dailySeries }));
        } catch (err) {
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: String(err) }));
        }
      });

      // Handle /api/telemetry/trust endpoint
      server.middlewares.use('/api/telemetry/trust', async (req, res) => {
        try {
          const url = new URL(req.url!, `http://${req.headers.host}`);
          const project = getProjectFilter(url);

          const allEvents = await readAllEvents(getTelemetryDir(project));

          const counters = aggregateTrustCounters(allEvents);

          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(counters));
        } catch (err) {
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: String(err) }));
        }
      });

      // Handle /api/telemetry/guardrail-events endpoint — read-only drill-down for the
      // chain-violation / guardrail-bump panel. Projects the JSONL sink to the recent
      // chain.violation + hook.guardrail_bump events with their execution-path context.
      // (backlog.feat.telemetry-dashboard-chain-violations-panel)
      server.middlewares.use('/api/telemetry/guardrail-events', async (req, res) => {
        try {
          const url = new URL(req.url!, `http://${req.headers.host}`);
          const project = getProjectFilter(url);
          const limitParam = url.searchParams.get('limit');
          const limit = limitParam ? Math.max(1, Math.min(500, Number(limitParam) || 100)) : 100;

          const allEvents = await readAllEvents(getTelemetryDir(project));
          const events = projectGuardrailEvents(allEvents, limit);

          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ events, total: events.length }));
        } catch (err) {
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: String(err) }));
        }
      });
    }
  };
}

// Pure, exported read-only projection of chain-violation + guardrail-bump events for the
// dashboard drill-down panel. Filters to the two guardrail event types, keeps each event's
// `payload` (where the execution-path context lives), and returns a most-recent-first slice.
// Read-only — never mutates the sink. (backlog.feat.telemetry-dashboard-chain-violations-panel)
const GUARDRAIL_EVENT_TYPES = new Set(['chain.violation', 'hook.guardrail_bump']);
export function projectGuardrailEvents(events: any[], limit: number = 100) {
  const matched: any[] = [];
  for (const event of events || []) {
    const type = (event && (event.type || event.event)) || '';
    if (!GUARDRAIL_EVENT_TYPES.has(type)) continue;
    matched.push({
      id: event.id ?? null,
      type,
      timestamp: event.timestamp ?? null,
      projectId: event.projectId ?? null,
      payload: event.payload ?? {},
    });
  }
  // Most-recent-first by ISO timestamp; entries without a timestamp sort last.
  matched.sort((a, b) => String(b.timestamp || '').localeCompare(String(a.timestamp || '')));
  return matched.slice(0, Math.max(0, limit));
}

// Pure, exported trust-counter aggregation extracted from the /api/telemetry/trust middleware
// so it is unit-testable with synthetic events (behavior-preserving). Adds a chainViolations
// counter for `chain.violation` events. (backlog.feat.chain-violation-telemetry-server-slice)
export function aggregateTrustCounters(events: any[]) {
  let guardrailsTriggered = 0, guardrailsPassed = 0, offRailSessions = 0;
  let hooksBlocked = 0, hooksAllowed = 0, chainViolations = 0, guardrailBumps = 0;
  for (const event of events || []) {
    const eventType = (event && (event.type || event.event)) || '';
    if (eventType.startsWith('guardrails.')) {
      if (eventType === 'guardrails.off') offRailSessions++;
      if (eventType.includes('blocked') || eventType.includes('failed')) guardrailsTriggered++;
      if (eventType.includes('passed') || eventType.includes('verified')) guardrailsPassed++;
    }
    if (eventType.startsWith('hooks.')) {
      if (eventType.includes('blocked')) hooksBlocked++;
      if (eventType.includes('allowed') || eventType.includes('passed')) hooksAllowed++;
    }
    if (eventType === 'chain.violation') chainViolations++;
    if (eventType === 'hook.guardrail_bump') guardrailBumps++;
  }
  const trustScore = (guardrailsPassed + hooksAllowed) > 0
    ? Math.round(((guardrailsPassed + hooksAllowed) / (guardrailsPassed + hooksAllowed + guardrailsTriggered + hooksBlocked)) * 100)
    : 100;
  return { trustScore, guardrailsTriggered, guardrailsPassed, offRailSessions, hooksBlocked, hooksAllowed, chainViolations, guardrailBumps };
}
