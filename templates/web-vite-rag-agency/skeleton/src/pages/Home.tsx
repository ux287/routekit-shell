import { HeroSection } from "../components/HeroSection";
import { CTASection } from "../components/CTASection";
import { SectionHeader } from "../components/SectionHeader";
import { AnimatedCard } from "../components/AnimatedCard";

const serviceCards = [
  { title: "AI Content Ops", description: "Blueprint editorial workflows with repeatable prompts." },
  { title: "Design Systems", description: "Ship wireframes to polish with guardrails baked in." },
  { title: "Delivery", description: "Hand-off to Vercel-ready bundles." },
];

export function Home() {
  return (
    <main className="space-y-16">
      <HeroSection />
      <SectionHeader title="Studio focus" description="Modular sections wired to RAG content." />
      <div className="grid gap-6 md:grid-cols-3">
        {serviceCards.map((card) => (
          <AnimatedCard key={card.title}>
            <h3 className="text-xl font-semibold">{card.title}</h3>
            <p className="mt-2 text-slate-600">{card.description}</p>
          </AnimatedCard>
        ))}
      </div>
      <CTASection />
    </main>
  );
}
