import { InputHTMLAttributes } from "react";

export function Input({ className = "", ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={`w-full rounded-xl border border-slate-200 px-4 py-3 focus:border-sky-400 focus:outline-none ${className}`.trim()}
      {...props}
    />
  );
}
