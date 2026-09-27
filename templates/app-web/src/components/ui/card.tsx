import * as React from "react";
import { cn } from "../../lib/utils";
export function Card({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("rounded-xl border border-border bg-white shadow-sm", className)} {...props} />;
}
export function CardHeader(props: React.HTMLAttributes<HTMLDivElement>) { return <div className="p-4 border-b border-border" {...props}/>; }
export function CardContent(props: React.HTMLAttributes<HTMLDivElement>) { return <div className="p-4" {...props}/>; }
export function CardFooter(props: React.HTMLAttributes<HTMLDivElement>) { return <div className="p-4 border-t border-border" {...props}/>; }