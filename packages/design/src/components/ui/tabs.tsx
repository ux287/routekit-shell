import * as React from "react";
import { cn } from "../../utils/cn";

type Tab = { id: string; label: string; content: React.ReactNode; };
export function Tabs({ tabs, className }: { tabs: Tab[]; className?: string }) {
  const [active, setActive] = React.useState(tabs[0]?.id);
  return (
    <div className={cn("w-full", className)}>
      <div className="flex gap-2 border-b border-slate-200">
        {tabs.map(t => (
          <button
            key={t.id}
            className={cn(
              "px-3 py-2 text-sm font-medium rounded-t-lg",
              active === t.id ? "bg-white border border-slate-200 border-b-white" : "text-slate-600 hover:bg-slate-100"
            )}
            onClick={() => setActive(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="rounded-b-2xl border border-slate-200 p-4">
        {tabs.find(t => t.id === active)?.content}
      </div>
    </div>
  );
}
