import * as React from "react";
import { cn } from "../../utils/cn";

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {}
export const Input = React.forwardRef<HTMLInputElement, InputProps>(({ className, ...props }, ref) => (
  <input
    ref={ref}
    className={cn(
      "flex h-10 w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm placeholder:text-slate-400",
      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600",
      className
    )}
    {...props}
  />
));
Input.displayName = "Input";
