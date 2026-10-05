export function About() {
  return (
    <section>
      <h1 className="text-3xl font-semibold">About</h1>
      <p className="mt-2 text-slate-600">
        A second route — proof client-side routing works. Add pages under
        <code className="mx-1 rounded bg-slate-100 px-1">src/pages/</code> and register them in
        <code className="mx-1 rounded bg-slate-100 px-1">src/App.tsx</code>.
      </p>
    </section>
  );
}
