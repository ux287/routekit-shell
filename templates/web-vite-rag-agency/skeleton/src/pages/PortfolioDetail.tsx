import { useParams } from "react-router-dom";

export function PortfolioDetail() {
  const { slug } = useParams();
  return (
    <main className="space-y-4">
      <p className="text-sm uppercase tracking-widest text-slate-500">Portfolio Detail</p>
      <h1 className="text-4xl font-semibold">{slug}</h1>
      <p className="text-slate-600">Populate this layout with a case study loaded from the portfolio index.</p>
    </main>
  );
}
