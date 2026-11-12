import { useState } from "react";
import { Button } from "../components/ui/button";

export function Home() {
  const [count, setCount] = useState(0);
  return (
    <section>
      <h1 className="text-3xl font-semibold">app.web.react.spa</h1>
      <p className="mt-2 text-slate-600">
        A minimal React + Vite + TypeScript + Tailwind SPA with client-side routing.
        Edit <code className="mx-1 rounded bg-slate-100 px-1">src/pages/Home.tsx</code> to build your app.
      </p>
      <div className="mt-6 flex items-center gap-3">
        <Button onClick={() => setCount((c) => c + 1)}>count is {count}</Button>
        <span className="text-slate-500">React state works.</span>
      </div>
    </section>
  );
}
