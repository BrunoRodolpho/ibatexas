import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      // ── Colors (warm-shifted, no pure white) ────────────────────────
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
          400: "#C4BDB3",
          500: "#A8A298",
          600: "#8C877E",
          700: "#706C64",
          800: "#55524B",
        },
        charcoal: {
          900: "#1A1614",
          800: "#231F1C",
          700: "#2E2924",
          600: "#3A352F",
        },
        accent: {
          green: "#2D6A4F",
          red: "#DC2626",
          amber: "#D97706",
        },
      },

      // ── Typography ──────────────────────────────────────────────────
      fontFamily: {
        sans: ["var(--font-inter)", "system-ui", "sans-serif"],
        display: ["var(--font-playfair)", "Georgia", "serif"],
      },
      fontSize: {
        micro: ["0.5625rem", { lineHeight: "0.75rem" }],
        "display-xl": ["4.5rem", { lineHeight: "1.05", letterSpacing: "-0.02em" }],
        "display-lg": ["3.75rem", { lineHeight: "1.08", letterSpacing: "-0.015em" }],
        "display-md": ["3rem", { lineHeight: "1.1", letterSpacing: "-0.01em" }],
        "display-sm": ["2.25rem", { lineHeight: "1.15", letterSpacing: "-0.005em" }],
        "display-xs": ["1.75rem", { lineHeight: "1.2", letterSpacing: "-0.005em" }],
        "display-2xs": ["1.375rem", { lineHeight: "1.25", letterSpacing: "0" }],
      },
      letterSpacing: {
        "editorial": "0.04em",
        "display": "-0.02em",
      },

      // ── Box Shadows (warm-tinted, minimal) ──────────────────────────
      boxShadow: {
        "xs":   "0 1px 2px 0 rgba(120,80,40,0.04)",
        "card": "0 1px 3px 0 rgba(120,80,40,0.04), 0 1px 2px -1px rgba(120,80,40,0.02)",
        "md":   "0 4px 12px -2px rgba(120,80,40,0.06), 0 2px 4px -2px rgba(120,80,40,0.03)",
        "lg":   "0 10px 24px -4px rgba(120,80,40,0.08), 0 4px 8px -2px rgba(120,80,40,0.03)",
        "xl":   "0 20px 48px -8px rgba(120,80,40,0.10), 0 8px 16px -4px rgba(120,80,40,0.04)",
      },

      // ── Border Radius ──────────────────────────────────────────────
      borderRadius: {
        card: "10px",
      },

      // ── Spacing (luxury editorial rhythm) ────────────────────────────
      spacing: {
        "18": "4.5rem",
        "22": "5.5rem",
        "30": "7.5rem",
        "34": "8.5rem",
        "38": "9.5rem",
      },

      // ── Transition (heavy, expensive feel) ──────────────────────────
      transitionTimingFunction: {
        luxury: "cubic-bezier(0.16, 1, 0.3, 1)",
      },
      transitionDuration: {
        "800": "800ms",
        "1000": "1000ms",
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
        reveal: {
          "0%":   { opacity: "0", transform: "translateY(16px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        "reveal-slow": {
          "0%":   { opacity: "0", transform: "translateY(24px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        marquee: {
          "0%":   { transform: "translateX(0)" },
          "100%": { transform: "translateX(-50%)" },
        },
        "bounce-subtle": {
          "0%":   { transform: "scale(1)" },
          "40%":  { transform: "scale(1.15)" },
          "100%": { transform: "scale(1)" },
        },
        press: {
          "0%":   { transform: "scale(1)" },
          "100%": { transform: "scale(0.95)" },
        },
        "snap-underline": {
          "0%":   { transform: "scaleX(0)" },
          "100%": { transform: "scaleX(1)" },
        },
        "slide-in-right": {
          "0%":   { transform: "translateX(100%)" },
          "100%": { transform: "translateX(0)" },
        },
        "slide-in-left": {
          "0%":   { transform: "translateX(-100%)" },
          "100%": { transform: "translateX(0)" },
        },
        "slide-in-bottom": {
          "0%":   { transform: "translateY(100%)" },
          "100%": { transform: "translateY(0)" },
        },
      },
      animation: {
        "fade-in":    "fade-in 0.3s cubic-bezier(0.16, 1, 0.3, 1) forwards",
        "slide-up":   "slide-up 0.35s cubic-bezier(0.16, 1, 0.3, 1) forwards",
        reveal:       "reveal 0.6s cubic-bezier(0.16, 1, 0.3, 1) forwards",
        "reveal-slow":"reveal-slow 0.8s cubic-bezier(0.16, 1, 0.3, 1) forwards",
        shimmer:      "shimmer 1.8s cubic-bezier(0.16, 1, 0.3, 1) infinite",
        marquee:      "marquee 40s linear infinite",
        "bounce-subtle": "bounce-subtle 0.4s cubic-bezier(0.16, 1, 0.3, 1) forwards",
        press:         "press 0.1s cubic-bezier(0.16, 1, 0.3, 1) forwards",
        "snap-underline": "snap-underline 0.1s linear forwards",
        "slide-in-right":  "slide-in-right 0.35s cubic-bezier(0.16, 1, 0.3, 1) forwards",
        "slide-in-left":   "slide-in-left 0.35s cubic-bezier(0.16, 1, 0.3, 1) forwards",
        "slide-in-bottom": "slide-in-bottom 0.35s cubic-bezier(0.16, 1, 0.3, 1) forwards",
      },
    },
  },
  plugins: [],
};

export default config;
