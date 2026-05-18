/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Audrey palette — tuned for a legal-context tool: muted, high
        // legibility, no candy. Refine when we have a brand pass.
        ink: {
          50:  '#f7f8fa',
          100: '#eceff4',
          200: '#d8dee9',
          300: '#a9b0bd',
          400: '#7a8290',
          500: '#525c6c',
          600: '#3a4350',
          700: '#272d37',
          800: '#181c23',
          900: '#0e1116',
        },
        accent: {
          // Used sparingly — primary actions, focused states.
          500: '#2d6cdf',
          600: '#1f57c5',
          700: '#1844a0',
        },
      },
      fontFamily: {
        sans: ['ui-sans-serif', 'system-ui', '-apple-system', 'BlinkMacSystemFont', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
    },
  },
  plugins: [],
};
