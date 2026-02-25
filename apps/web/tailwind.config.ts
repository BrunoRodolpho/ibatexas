import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      // ── Colors ──────────────────────────────────────────────────────
      colors: {
        brand: {
          50:  "#FFF4EE",
          100: "#FFE4CC",
          200: "#FFC599",
          300: "#FFA066",
          400: "#FF7A33",
          500: "#E85D04",
          600: "#C94E00",
          700: "#A84000",
          800: "#7A2F00",
          900: "#3D1800",
        },
        smoke: {
          50:  "#FAFAF9",
          100: "#F5F3F0",
          200: "#EDE9E3",
          300: "#DDD8CF",
        },
      },

      // ── Typography ──────────────────────────────────────────────────
      fontFamily: {
        sans: ["var(--font-inter)", "system-ui", "sans-serif"],
      },

      // ── Box Shadows (Stripe-style layered, no color glow) ──────────
      boxShadow: {
        "xs":   "0 1px 2px 0 rgba(0,0,0,0.05)",
        "card": "0 1px 3px 0 rgba(0,0,0,0.06), 0 1px 2px -1px rgba(0,0,0,0.04)",
        "md":   "0 4px 12px -2px rgba(0,0,0,0.08), 0 2px 4px -2px rgba(0,0,0,0.04)",
        "lg":   "0 10px 24px -4px rgba(0,0,0,0.10), 0 4px 8px -2px rgba(0,0,0,0.04)",
        "xl":   "0 20px 48px -8px rgba(0,0,0,0.12), 0 8px 16px -4px rgba(0,0,0,0.06)",
      },

      // ── Keyframes & Animations ───────────────────────────────────────
      keyframes: {
        "fade-in": {
          "0%":   { opacity: "0" },
          "100%": { opacity: "1" },
        },
        "slide-up": {
          "0%":   { opacity: "0", transform: "translateY(8px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        shimmer: {
          "0%":   { backgroundPosition: "-200% 0" },
          "100%": { backgroundPosition: "200% 0" },
        },
      },
      animation: {
        "fade-in":  "fade-in 0.2s ease-out forwards",
        "slide-up": "slide-up 0.2s ease-out forwards",
        shimmer:    "shimmer 1.8s linear infinite",
      },
    },
  },
  plugins: [],
};

export default config;
