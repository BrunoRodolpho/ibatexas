import type { Config } from 'tailwindcss'

const config: Config = {
  content: [
    './src/components/**/*.{js,ts,jsx,tsx,mdx}',
    './src/app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        brand: {
          50: '#FFF4EE', 100: '#FFE4CC', 200: '#FFC599', 300: '#FFA066',
          400: '#FF7A33', 500: '#E85D04', 600: '#C94E00', 700: '#A84000',
          800: '#7A2F00', 900: '#3D1800',
        },
        smoke: {
          50: '#FAFAF9', 100: '#F5F3F0', 200: '#EDE9E3', 300: '#DDD8CF',
          400: '#C4BDB3', 500: '#A8A298', 600: '#8C877E', 700: '#706C64',
          800: '#55524B',
        },
        charcoal: {
          900: '#1A1614', 800: '#231F1C', 700: '#2E2924', 600: '#3A352F',
        },
        accent: { green: '#2D6A4F', red: '#DC2626', amber: '#D97706' },
      },
      fontFamily: {
        sans: ['var(--font-inter)', 'system-ui', 'sans-serif'],
        display: ['var(--font-playfair)', 'Georgia', 'serif'],
      },
      boxShadow: {
        xs: '0 1px 2px 0 rgba(120,80,40,0.04)',
        card: '0 1px 3px 0 rgba(120,80,40,0.04), 0 1px 2px -1px rgba(120,80,40,0.02)',
        md: '0 4px 12px -2px rgba(120,80,40,0.06), 0 2px 4px -2px rgba(120,80,40,0.03)',
        lg: '0 10px 24px -4px rgba(120,80,40,0.08), 0 4px 8px -2px rgba(120,80,40,0.03)',
        xl: '0 20px 48px -8px rgba(120,80,40,0.10), 0 8px 16px -4px rgba(120,80,40,0.04)',
      },
      borderRadius: { card: '10px' },
      letterSpacing: { editorial: '0.04em', display: '-0.02em' },
      transitionTimingFunction: { luxury: 'cubic-bezier(0.16, 1, 0.3, 1)' },
      keyframes: {
        'fade-in': { '0%': { opacity: '0' }, '100%': { opacity: '1' } },
        'slide-up': { '0%': { opacity: '0', transform: 'translateY(8px)' }, '100%': { opacity: '1', transform: 'translateY(0)' } },
        'slide-in-right': { '0%': { transform: 'translateX(100%)' }, '100%': { transform: 'translateX(0)' } },
        'slide-in-left': { '0%': { transform: 'translateX(-100%)' }, '100%': { transform: 'translateX(0)' } },
        'slide-in-bottom': { '0%': { transform: 'translateY(100%)' }, '100%': { transform: 'translateY(0)' } },
      },
      animation: {
        'fade-in': 'fade-in 0.3s cubic-bezier(0.16, 1, 0.3, 1) forwards',
        'slide-up': 'slide-up 0.35s cubic-bezier(0.16, 1, 0.3, 1) forwards',
        'slide-in-right': 'slide-in-right 0.35s cubic-bezier(0.16, 1, 0.3, 1) forwards',
        'slide-in-left': 'slide-in-left 0.35s cubic-bezier(0.16, 1, 0.3, 1) forwards',
        'slide-in-bottom': 'slide-in-bottom 0.35s cubic-bezier(0.16, 1, 0.3, 1) forwards',
      },
    },
  },
  plugins: [],
}

export default config
