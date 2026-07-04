import { PropsWithChildren } from "react";

export function AnimatedCard({ children }: PropsWithChildren) {
  return (
    <article className="rounded-2xl border border-slate-200 bg-white/80 p-6 shadow-sm transition hover:-translate-y-1 hover:shadow-xl">
      {children}
    </article>
  );
}
