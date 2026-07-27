import { ButtonHTMLAttributes } from "react";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "ghost";
}

export function Button({ variant = "primary", className = "", ...props }: ButtonProps) {
  const base = "rounded-full px-4 py-2 font-medium transition";
  const styles =
    variant === "primary"
      ? "bg-sky-500 text-slate-900 hover:bg-sky-400"
      : "bg-transparent text-slate-900 border border-slate-200 hover:border-slate-400";
  return <button className={`${base} ${styles} ${className}`.trim()} {...props} />;
}
