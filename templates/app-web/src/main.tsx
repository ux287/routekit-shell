import React from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router-dom";
import "./styles/globals.css";

// Layout and Pages
import Layout from "./components/Layout";
import HomePage from "./pages/HomePage";
import DocsPage from "./pages/DocsPage";
import GuidesPage from "./pages/GuidesPage";
import BlogPage from "./pages/BlogPage";
import Demo from "./pages/routekit-demo";

const router = createBrowserRouter([
  {
    path: "/",
    element: <Layout />,
    children: [
      {
        index: true,
        element: <HomePage />,
      },
      {
        path: "docs",
        element: <DocsPage />,
      },
      {
        path: "guides",
        element: <GuidesPage />,
      },
      {
        path: "blog",
        element: <BlogPage />,
      },
      {
        path: "demo",
        element: <Demo />,
      },
    ],
  },
]);

createRoot(document.getElementById("root")!).render(
  <RouterProvider router={router} />
);