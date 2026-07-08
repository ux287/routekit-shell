import { SectionHeader } from "../components/SectionHeader";
import { AnimatedCard } from "../components/AnimatedCard";

const services = [
  { name: "Strategy", detail: "Audience research, positioning, and success metrics." },
  { name: "Production", detail: "Component driven content updates with AI assist." },
  { name: "Growth", detail: "Analytics hooks and experiments." },
];

export function Services() {
  return (
    <main className="space-y-12">
      <SectionHeader title="Services" description="Tune copy, surfaces, and extensions." />
      <div className="grid gap-6 md:grid-cols-2">
        {services.map((service) => (
          <AnimatedCard key={service.name}>
            <h3 className="text-2xl font-semibold">{service.name}</h3>
            <p className="mt-3 text-slate-600">{service.detail}</p>
          </AnimatedCard>
        ))}
      </div>
    </main>
  );
}
