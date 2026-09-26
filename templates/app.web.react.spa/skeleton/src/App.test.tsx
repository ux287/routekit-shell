import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { App } from "./App";

/**
 * Route + nav tests for the SPA shell.
 *
 * App does not create its own Router (so it can be mounted under whatever router the host provides),
 * so tests wrap it in a MemoryRouter and drive the URL with `initialEntries`.
 *
 * ⚠️ THE NAV-COLLISION RULE — read before adding a route test.
 *
 * A route's name appears TWICE in the DOM: once as the nav link (`<a>About</a>`) and once as the
 * page heading (`<h1>About</h1>`). So a bare `getByText` for the route name matches BOTH elements and
 * throws "Found multiple elements with the text: /about/i".
 *
 * `getByText` throws on multiple matches, by design. This is the single most common way a generated
 * route test breaks the moment you add the page to the nav — which the About page itself tells you to
 * do. Always scope a route-name assertion to a UNIQUE element:
 *
 *     screen.getByRole("heading", { name: /about/i })          // ✅ the <h1>, and only the <h1>
 *     within(screen.getByRole("main")).getByText(/about/i)     // ✅ scoped to page content
 *     screen.getAllByText(/about/i)                            // ✅ when you want "is it present at all"
 *
 * Never a bare `getByText(routeName)` next to a `<Link>routeName</Link>`.
 */
function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
}

describe("App routing and nav", () => {
  it("renders the nav with links to every route", () => {
    renderAt("/");
    expect(screen.getByRole("link", { name: /home/i })).toHaveAttribute("href", "/");
    expect(screen.getByRole("link", { name: /about/i })).toHaveAttribute("href", "/about");
  });

  it("renders the Home page at /", () => {
    renderAt("/");
    // Home's heading text ("app.web.react.spa") differs from its nav label ("Home"), so it does not
    // collide — but the role-scoped query is still the habit to keep.
    expect(screen.getByRole("heading", { name: /app\.web\.react\.spa/i })).toBeInTheDocument();
  });

  it("renders the About page at /about — scoped to the heading, NOT a bare text match", () => {
    renderAt("/about");

    // The route name is genuinely on the page twice: the nav link and the <h1>.
    expect(screen.getAllByText(/about/i)).toHaveLength(2);

    // So we assert the HEADING specifically. This is the whole point of the file's warning above.
    expect(screen.getByRole("heading", { name: /about/i })).toBeInTheDocument();
  });
});
