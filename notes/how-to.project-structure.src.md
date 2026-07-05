---
id: how-to.project-structure.src
title: Src
desc: Project structure documentation for RouteKit Shell
updated: '2025-09-02T16:22:55.442Z'
created: '2025-09-02T16:22:55.442Z'
---

# Source Code Structure (src/)

## Directory Layout

```
src/
├── components/         # Reusable UI components
│   └── Layout.tsx     # Main layout wrapper
├── pages/             # Route-based page components
│   ├── HomePage.tsx   # Landing page
│   ├── DocsPage.tsx   # Documentation listing
│   └── ...
├── utils/             # Utility functions
│   └── contentLoader.ts # Dynamic content loading
├── styles/            # Styling and CSS
│   └── globals.css    # Global styles with Tailwind
└── main.tsx           # Application entry point
```

## Components Directory

### Purpose

Reusable UI components that can be used across multiple pages.

### Best Practices

- One component per file
- Use TypeScript interfaces for props
- Export as default
- Include JSDoc comments for complex components

### Example Component

```typescript
// src/components/Layout.tsx
export default function Layout() {
  return (
    <div className="min-h-screen">
      <nav>...</nav>
      <main>
        <Outlet /> {/* React Router outlet */}
      </main>
    </div>
  );
}
```

## Pages Directory

### Purpose

Top-level route components that represent distinct pages/views.

### Naming Convention

- `HomePage.tsx` → `/` route
- `DocsPage.tsx` → `/docs` route
- `BlogPage.tsx` → `/blog` route

### Page Structure

```typescript
// src/pages/HomePage.tsx
export default function HomePage() {
  return (
    <div className="px-4 py-8">
      {/* Page content */}
    </div>
  );
}
```

## Utils Directory

### Purpose

Pure functions, API clients, and shared utilities.

### Common Utils

- `contentLoader.ts` - Load and parse documentation
- `api.ts` - API client functions
- `helpers.ts` - General utility functions

### Example Utility

```typescript
// src/utils/contentLoader.ts
export async function loadDocs(): Promise<DocItem[]> {
  // Load and parse documentation files
}
```

## Styles Directory

### Global Styles

```css
/* src/styles/globals.css */
@tailwind base;
@tailwind components;
@tailwind utilities;

/* Custom global styles */
```

## Main Entry Point

### main.tsx

- Application bootstrap
- React Router setup
- Global providers
- Root component mounting

```typescript
// src/main.tsx
import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import Layout from './components/Layout';
import HomePage from './pages/HomePage';

const router = createBrowserRouter([
  {
    path: '/',
    element: <Layout />,
    children: [
      { index: true, element: <HomePage /> },
      // ... other routes
    ],
  },
]);

createRoot(document.getElementById('root')!).render(
  <RouterProvider router={router} />
);
```

---

**Next:** [Scripts Directory →](routekit-shell.how-to.project-structure.scripts.md)
