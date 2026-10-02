/** @type {import('tailwindcss').Config} */
export default {
  // Pinned to the class strategy on purpose, and for a forward-looking reason. This
  // host's index.html declares NO dark class, so dark: stays inert here. Today that
  // is belt-and-braces: content does not scan ../presentations/src, so Deck.tsx's
  // utilities are never emitted for this build at all. When that glob is added, this
  // key is what keeps the dashboard chrome light.
  darkMode: "class",
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
    "../design/src/**/*.{js,ts,jsx,tsx}"
  ],
  theme: {
    extend: {
      colors: {
        brand: {
          50: "#eef2ff",
          100: "#e0e7ff",
          200: "#c7d2fe",
          300: "#a5b4fc",
          400: "#818cf8",
          500: "#6366f1",
          600: "#4f46e5",
          700: "#4338ca",
          800: "#3730a3",
          900: "#312e81"
        },
        // ux287.com bright-blue accent for the Presentations kit.
        accent: {
          DEFAULT: "#3b82f6",
          50: "#eff6ff",
          100: "#dbeafe",
          200: "#bfdbfe",
          300: "#93c5fd",
          400: "#60a5fa",
          500: "#3b82f6",
          600: "#2563eb",
          700: "#1d4ed8",
          800: "#1e40af",
          900: "#1e3a8a"
        },
        // Dark-hero background tokens (near-black + deep-blue variants).
        hero: {
          dark: "#0a0a0a",
          night: "#0b1220",
          blue: "#1e3a8a"
        }
      }
    }
  },
  plugins: []
};
