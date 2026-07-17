import { NavLink } from 'react-router-dom';
import clsx from 'clsx';
import { navSections } from '../../nav/navSections';

/**
 * Persistent top-level nav. Renders by mapping over the navSections registry
 * (not hardcoded links) and applies active-route styling via NavLink isActive.
 */
export function TopNav() {
  return (
    <nav className="flex items-center gap-1">
      {navSections.map((section) => {
        const Icon = section.icon;
        return (
          <NavLink
            key={section.id}
            to={section.path}
            end={section.path === '/'}
            className={({ isActive }) =>
              clsx(
                'flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors',
                isActive ? 'bg-accent/10 text-accent' : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
              )
            }
          >
            <Icon className="h-4 w-4" />
            {section.label}
          </NavLink>
        );
      })}
    </nav>
  );
}
