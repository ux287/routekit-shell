import { Card, CardContent } from '../ui/card';
import { LucideIcon } from 'lucide-react';
import { clsx } from 'clsx';

interface MetricCardProps {
  title: string;
  value: string | number;
  icon?: LucideIcon;
  variant?: 'default' | 'success' | 'warning' | 'danger';
}

const variantStyles = {
  default: 'border-slate-200',
  success: 'border-emerald-200 bg-emerald-50',
  warning: 'border-amber-200 bg-amber-50',
  danger: 'border-red-200 bg-red-50',
};

export function MetricCard({ title, value, icon: Icon, variant = 'default' }: MetricCardProps) {
  return (
    <Card className={clsx('transition-shadow hover:shadow-md', variantStyles[variant])}>
      <CardContent className="flex items-center justify-between p-6">
        <div>
          <p className="text-sm text-slate-500">{title}</p>
          <p className="text-3xl font-bold text-slate-900">{value}</p>
        </div>
        {Icon && <Icon className="h-8 w-8 text-slate-400" />}
      </CardContent>
    </Card>
  );
}
