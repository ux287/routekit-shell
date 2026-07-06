interface SectionHeaderProps {
  eyebrow?: string;
  title: string;
  description?: string;
}

export function SectionHeader({ eyebrow, title, description }: SectionHeaderProps) {
  return (
    <header className="space-y-2 text-center">
      {eyebrow && <p className="text-sm uppercase tracking-widest text-sky-500">{eyebrow}</p>}
      <h2 className="text-4xl font-semibold text-slate-900">{title}</h2>
      {description && <p className="text-lg text-slate-600">{description}</p>}
    </header>
  );
}
