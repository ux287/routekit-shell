import { PropsWithChildren } from "react";

export function Card({ children }: PropsWithChildren) {
  return <div className="rounded-2xl border border-slate-100 bg-white p-6 shadow-sm">{children}</div>;
}
