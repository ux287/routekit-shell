import type { ComponentType } from 'react';
import { Activity, Presentation } from 'lucide-react';

/** A single top-level nav home. */
export interface NavSection {
  id: string;
  label: string;
  /** Route path (matches a <Route> in App.tsx) */
  path: string;
  icon: ComponentType<{ className?: string }>;
}

/**
 * Extensible top-level nav registry. TopNav maps over this array, so adding one
 * entry here adds one nav home — the shell is NOT hardcoded to two sections.
 * Seeded with Telemetry + Presentations; future rks UI sections append here.
 */
export const navSections: NavSection[] = [
  { id: 'telemetry', label: 'Telemetry', path: '/', icon: Activity },
  { id: 'presentations', label: 'Presentations', path: '/presentations', icon: Presentation },
];
