import type { Config } from 'tailwindcss';

const config: Config = {
  content: [
    './pages/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
    './app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        background: '#0D0614',
        foreground: '#F5EDF8',
        plum: {
          900: '#1A0624',
          800: '#2A0B3B',
          700: '#43125C',
          600: '#5F1982',
          500: '#7F22AD',
          400: '#A439DC',
        },
        rose: {
          highlight: '#FF2A85',
        },
        cyan: {
          neon: '#00F0FF',
        },
      },
      fontFamily: {
        sans: ['DM Sans', 'sans-serif'],
        serif: ['Playfair Display', 'serif'],
      },
    },
  },
  plugins: [],
};
export default config;
