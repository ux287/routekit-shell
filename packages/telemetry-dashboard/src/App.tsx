import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HashRouter, Routes, Route } from 'react-router-dom';
import { FilterProvider } from './lib/FilterContext';
import { Header } from './components/layout/Header';
import { TelemetryPage } from './pages/TelemetryPage';
import type { ReactElement } from 'react';

// Optional, publish-excluded route modules. `import.meta.glob` resolves to an
// empty object when src/presentations/ is absent (the public mirror), so this
// file carries no dangling import into the published tree.
const optionalRouteModules = import.meta.glob<{ optionalRoutes?: ReactElement[] }>(
  './presentations/routes.tsx',
  { eager: true }
);
const optionalRoutes: ReactElement[] = Object.values(optionalRouteModules).flatMap(
  (m) => m.optionalRoutes ?? []
);

const queryClient = new QueryClient();

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <FilterProvider>
        <HashRouter>
          <div className="min-h-screen bg-slate-50">
            <Header />
            <Routes>
              <Route path="/" element={<TelemetryPage />} />
              {optionalRoutes}
            </Routes>
          </div>
        </HashRouter>
      </FilterProvider>
    </QueryClientProvider>
  );
}
