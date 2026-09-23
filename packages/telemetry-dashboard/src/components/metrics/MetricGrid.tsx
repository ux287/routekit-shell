interface MetricGridProps {
  children: React.ReactNode;
}

export function MetricGrid({ children }: MetricGridProps) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
      {children}
    </div>
  );
}
