import plugin from "tailwindcss/plugin";

export default {
  content: [],
  theme: {
    extend: {
      colors: {
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        border: "hsl(var(--border))",
        muted: "hsl(var(--muted))",
        primary: "hsl(var(--primary))",
        primaryForeground: "hsl(var(--primary-foreground))"
      },
      borderRadius: {
        lg: "var(--radius-lg)",
        xl: "var(--radius-xl)"
      }
    }
  },
  plugins: [
    plugin(function({ addBase }) {
      addBase({
        ":root": {
          "--background": "0 0% 100%",
          "--foreground": "222.2 47.4% 11.2%",
          "--muted": "210 40% 96.1%",
          "--border": "214.3 31.8% 91.4%",
          "--primary": "221.2 83.2% 53.3%",
          "--primary-foreground": "210 40% 98%",
          "--radius-lg": "0.75rem",
          "--radius-xl": "1rem"
        }
      });
    })
  ]
};