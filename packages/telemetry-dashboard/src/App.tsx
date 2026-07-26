import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HashRouter, Routes, Route } from 'react-router-dom';
import { FilterProvider } from './lib/FilterContext';
import { Header } from './components/layout/Header';
import { TelemetryPage } from './pages/TelemetryPage';
import { PresentationsIndex } from './presentations/PresentationsIndex';
import { DeckViewer } from './presentations/DeckViewer';

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
              <Route path="/presentations" element={<PresentationsIndex />} />
              <Route path="/presentations/:deckSlug" element={<DeckViewer />} />
            </Routes>
          </div>
        </HashRouter>
      </FilterProvider>
    </QueryClientProvider>
  );
}
