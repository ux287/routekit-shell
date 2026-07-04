import logo from "../assets/logo.svg";

export function HeroSection() {
  return (
    <section className="flex flex-col items-center gap-6 py-20 text-center">
      <img src={logo} alt="Stack logo" className="h-10" />
      <p className="max-w-2xl text-lg text-slate-600">
        Launch AI-assisted agency sites with a Vite + Tailwind foundation. Wire your hero copy, CTA, and
        data driven case studies in one place.
      </p>
    </section>
  );
}
