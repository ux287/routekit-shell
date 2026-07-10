import grid from "../data/portfolio.json";

export function Portfolio() {
  return (
    <main className="space-y-8">
      <h1 className="text-4xl font-semibold">Portfolio</h1>
      <div className="grid gap-6 md:grid-cols-2">
        {grid.map((item) => (
          <article key={item.slug} className="rounded-2xl border border-slate-200 p-6">
            <p className="text-sm uppercase tracking-wider text-slate-500">Case Study</p>
            <h2 className="mt-2 text-2xl font-semibold">{item.title}</h2>
            <p className="mt-3 text-slate-600">Slug: {item.slug}</p>
          </article>
        ))}
      </div>
    </main>
  );
}
