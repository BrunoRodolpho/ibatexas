import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      // ── Brand Colors ────────────────────────────────────────────────
      colors: {
        brand: {
          50:  "#FFF4EE",
          100: "#FFE4CC",
          200: "#FFC599",
          300: "#FFA066",
          400: "#FF7A33",
          500: "#E85D04",   // PRIMARY: vivid fire-orange
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
        sans:    ["var(--font-inter)", "system-ui", "sans-serif"],
        display: ["var(--font-outfit)", "var(--font-inter)", "sans-serif"],
      },
      fontSize: {
        "display-2xl": ["5rem",     { lineHeight: "1.05",  letterSpacing: "-0.03em",  fontWeight: "800" }],
        "display-xl":  ["4rem",     { lineHeight: "1.08",  letterSpacing: "-0.025em", fontWeight: "800" }],
        "display-lg":  ["3rem",     { lineHeight: "1.1",   letterSpacing: "-0.02em",  fontWeight: "700" }],
        "display-md":  ["2.25rem",  { lineHeight: "1.15",  letterSpacing: "-0.015em", fontWeight: "700" }],
        "display-sm":  ["1.875rem", { lineHeight: "1.2",   letterSpacing: "-0.01em",  fontWeight: "700" }],
      },

      // ── Box Shadows ─────────────────────────────────────────────────
      boxShadow: {
        "glow-brand":    "0px 10px 40px -10px rgba(232,93,4,0.55)",
        "glow-brand-lg": "0px 20px 60px -10px rgba(232,93,4,0.45)",
        "card-sm":       "0 1px 3px 0 rgba(0,0,0,0.06), 0 1px 2px -1px rgba(0,0,0,0.06)",
        "card-md":       "0 4px 16px -2px rgba(0,0,0,0.08), 0 2px 6px -2px rgba(0,0,0,0.06)",
        "card-lg":       "0 12px 40px -4px rgba(0,0,0,0.10), 0 4px 12px -2px rgba(0,0,0,0.06)",
        "card-hover":    "0 20px 60px -8px rgba(0,0,0,0.14), 0 8px 20px -4px rgba(0,0,0,0.08)",
        "header":        "0 1px 0 0 rgba(0,0,0,0.06), 0 2px 8px -2px rgba(0,0,0,0.04)",
      },

      // ── Border Radius ────────────────────────────────────────────────
      borderRadius: {
        "2xl": "1rem",
        "3xl": "1.5rem",
        "4xl": "2rem",
      },

      // ── Backdrop Blur ────────────────────────────────────────────────
      backdropBlur: {
        header: "12px",
      },

      // ── Transition Timing ────────────────────────────────────────────
      transitionTimingFunction: {
        smooth: "cubic-bezier(0.4,0,0.2,1)",
        spring: "cubic-bezier(0.34,1.56,0.64,1)",
      },

      // ── Keyframes & Animations ───────────────────────────────────────
      keyframes: {
        float: {
          "0%,100%": { transform: "translateY(0)" },
          "50%":     { transform: "translateY(-8px)" },
        },
        "fade-up": {
          "0%":   { opacity: "0", transform: "translateY(16px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        "fade-in": {
          "0%":   { opacity: "0" },
          "100%": { opacity: "1" },
        },
        "slide-up": {
          "0%":   { opacity: "0", transform: "translateY(20px) scale(0.97)" },
          "100%": { opacity: "1", transform: "translateY(0) scale(1)" },
        },
        shimmer: {
          "0%":   { backgroundPosition: "-200% 0" },
          "100%": { backgroundPosition: "200% 0" },
        },
      },
      animation: {
        float:      "float 4s ease-in-out infinite",
        "fade-up":  "fade-up 0.5s ease-out forwards",
        "fade-in":  "fade-in 0.3s ease-out forwards",
        "slide-up": "slide-up 0.25s cubic-bezier(0.34,1.56,0.64,1) forwards",
        shimmer:    "shimmer 1.8s linear infinite",
      },
    },
  },
  plugins: [],
};

export default config;
