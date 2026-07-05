import { useParams } from "react-router-dom";

export function ThinkingDetail() {
  const { slug } = useParams();
  return (
    <main className="space-y-4">
      <p className="text-sm uppercase tracking-wider text-slate-500">Thought Piece</p>
      <h1 className="text-4xl font-semibold">{slug}</h1>
      <p className="text-slate-600">Replace this with content resolved from the notes mirror.</p>
    </main>
  );
}
