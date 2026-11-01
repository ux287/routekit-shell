import { Link, Route, Routes } from "react-router-dom";
import { Home } from "./pages/Home";
import { About } from "./pages/About";

// App shell: navigation + client-side routes. Add pages under src/pages/ and
// register them here. This is the "renders a SPA + does basic routing" baseline
// every app needs; richer capabilities (a blog, auth, data) come as additions.
export function App() {
  return (
    <main>
      <nav className="mb-8 flex gap-4 text-sm font-medium">
        <Link className="text-slate-700 hover:text-slate-900" to="/">Home</Link>
        <Link className="text-slate-700 hover:text-slate-900" to="/about">About</Link>
      </nav>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/about" element={<About />} />
      </Routes>
    </main>
  );
}
