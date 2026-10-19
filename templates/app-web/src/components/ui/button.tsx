import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cn } from "../../lib/utils";

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  asChild?: boolean;
  variant?: "default" | "outline" | "ghost";
  size?: "sm" | "md" | "lg";
}

const base = "inline-flex items-center justify-center rounded-lg font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 disabled:opacity-50";
const variants = {
  default: "bg-primary text-primaryForeground hover:opacity-90",
  outline: "border border-border bg-white hover:bg-muted",
  ghost: "hover:bg-muted"
};
const sizes = { sm: "h-9 px-3", md: "h-10 px-4", lg: "h-11 px-6" };

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant="default", size="md", asChild, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp
        ref={ref as any}
        className={cn(base, variants[variant], sizes[size], className)}
        {...props}
      />
    );
  }
);
Button.displayName = "Button";