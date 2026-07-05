import { SectionHeader } from "../components/SectionHeader";
import posts from "../data/blog-index.json";

export function Thinking() {
  return (
    <main className="space-y-8">
      <SectionHeader title="Thinking" description="Reference essays sourced from the notes vault." />
      <ul className="space-y-4">
        {posts.map((post) => (
          <li key={post.slug} className="rounded-2xl border border-slate-200 p-4">
            <p className="font-semibold">{post.title}</p>
            <p className="text-sm text-slate-500">Slug: {post.slug}</p>
          </li>
        ))}
      </ul>
    </main>
  );
}
