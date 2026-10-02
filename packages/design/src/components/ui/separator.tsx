import { cn } from "../../utils/cn";

export const Separator = ({ className }: { className?: string }) => (
  <div className={cn("h-px w-full bg-slate-200", className)} />
);
