import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { useFilters } from '../../lib/FilterContext';
import { fetchProjects } from '../../lib/api';
import { TimeRangePicker } from './TimeRangePicker';

export function FilterBar() {
  const { filters, setOnlyFailures, setProject, resetFilters } = useFilters();
  const [projects, setProjects] = useState<string[]>([]);

  useEffect(() => {
    fetchProjects()
      .then(data => setProjects(data.projects || []))
      .catch(() => setProjects([]));
  }, []);

  // The selected value: use filters.project if set, otherwise default to first project
  const selectedProject = filters.project || (projects.length > 0 ? projects[0] : '');

  const hasActiveFilters = filters.onlyFailures;

  return (
    <div className="flex flex-wrap items-center gap-4 p-4 bg-white rounded-lg border border-slate-200 shadow-sm">
      <label className="flex items-center gap-2 text-sm">
        <span className="text-slate-600 font-medium">Project</span>
        <select
          value={selectedProject}
          onChange={(e) => setProject(e.target.value || null)}
          className="rounded border-slate-300 text-sm py-1 px-2 bg-white focus:ring-indigo-500 focus:border-indigo-500"
        >
          {projects.map(p => (
            <option key={p} value={p}>{p}</option>
          ))}
        </select>
      </label>

      <div className="h-6 w-px bg-slate-200" />

      <TimeRangePicker />

      <div className="h-6 w-px bg-slate-200" />

      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={filters.onlyFailures}
          onChange={(e) => setOnlyFailures(e.target.checked)}
          className="rounded border-slate-300 text-red-600 focus:ring-red-500"
        />
        <span className="text-slate-600">Only failures</span>
      </label>

      {hasActiveFilters && (
        <>
          <div className="h-6 w-px bg-slate-200" />
          <button
            onClick={resetFilters}
            className="flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700"
          >
            <X className="h-4 w-4" />
            Clear filters
          </button>
        </>
      )}
    </div>
  );
}
