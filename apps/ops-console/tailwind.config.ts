import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./src/**/*.{js,ts,jsx,tsx,mdx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Manrope', 'sans-serif'],
        mono: ['JetBrains Mono', 'monospace'],
      },
      colors: {
        canvas:   '#04101F',
        primary:  '#0A1F3F',
        depth:    '#06142B',
        s1:       '#1B3A66',
        s2:       '#162F54',
        s3:       '#122747',
        act:      '#1E88FF',
        'act-hov':'#3BA6FF',
        'act-dim':'#244C82',
        acc:      '#00A3FF',
        glow:     '#7ED6FF',
        t1:       '#FFFFFF',
        t2:       '#B8C7E0',
        t3:       '#7E8AA6',
        bd1:      '#244C82',
        bd2:      '#1C3B66',
        ok:       '#00C853',
        warn:     '#FFC107',
        err:      '#D50000',
        info:     '#3BA6FF',
      },
      keyframes: {
        pulse: { '50%': { boxShadow: '0 0 0 4px rgba(213,0,0,0.1)' } },
        mpulse: {
          '0%': { opacity: '0.8', transform: 'scale(0.8)' },
          '100%': { opacity: '0', transform: 'scale(2.2)' },
        },
      },
      animation: {
        pulse:  'pulse 2s ease-in-out infinite',
        mpulse: 'mpulse 2.2s ease-out infinite',
      },
    },
  },
  plugins: [],
};

export default config;
