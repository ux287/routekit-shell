import { TopNav } from './TopNav';

export function Header() {
  return (
    <header className="bg-white border-b border-slate-200 px-4 py-3">
      <div className="container mx-auto flex items-center gap-6">
        <div className="flex items-center gap-3">
          <span className="text-2xl font-black tracking-tight text-indigo-600">RKS</span>
          <div className="h-6 w-px bg-slate-300" />
          <h1 className="text-lg font-semibold text-slate-900">Routekit Dashboard</h1>
        </div>
        <TopNav />
      </div>
    </header>
  );
}
