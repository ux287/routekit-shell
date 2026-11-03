import { FilterBar } from '../components/filters/FilterBar';
import { DashboardMetrics } from '../components/metrics/DashboardMetrics';
import { EventTimeline } from '../components/events/EventTimeline';
import { TypeBreakdownChart } from '../components/charts/TypeBreakdownChart';
import { StoryActivityTable } from '../components/stories/StoryActivityTable';
import { HealthStatus } from '../components/health/HealthStatus';
import { PipelineFunnel } from '../components/health/PipelineFunnel';
import { LatencyChart } from '../components/health/LatencyChart';
import { TrustMetrics } from '../components/health/TrustMetrics';
import { GuardrailBumps } from '../components/health/GuardrailBumps';
import { FailureBreakdown } from '../components/failures/FailureBreakdown';
import { TokenCostSection } from '../components/costs/TokenCostSection';

/**
 * The telemetry view, extracted verbatim from the old App.tsx body. Unchanged
 * in function — it now renders under the Routekit Dashboard nav at the "/" route
 * instead of being the whole app.
 */
export function TelemetryPage() {
  return (
    <main className="container mx-auto px-4 py-8 space-y-8">
      <FilterBar />
      <section className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <HealthStatus />
        <PipelineFunnel />
        <TrustMetrics />
        <LatencyChart />
      </section>

      <section>
        <GuardrailBumps />
      </section>

      <section>
        <h2 className="text-lg font-semibold mb-4">Overview</h2>
        <DashboardMetrics />
      </section>

      <section className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        <TypeBreakdownChart />
        <FailureBreakdown />
      </section>

      <section>
        <EventTimeline />
      </section>

      <section>
        <StoryActivityTable />
      </section>

      <section>
        <TokenCostSection />
      </section>
    </main>
  );
}
