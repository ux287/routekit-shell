import * as React from "react";
import { Button } from "./button";

export function Dialog({ trigger, title, children }: { trigger: string; title: string; children: React.ReactNode }) {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>{trigger}</Button>
      {open && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/40">
          <div className="w-full max-w-md rounded-2xl bg-white shadow-xl">
            <div className="flex items-center justify-between p-4 border-b border-slate-100">
              <h3 className="text-base font-semibold">{title}</h3>
              <button onClick={() => setOpen(false)} className="p-2 text-slate-500 hover:text-slate-900">✕</button>
            </div>
            <div className="p-4">{children}</div>
          </div>
        </div>
      )}
    </>
  );
}
