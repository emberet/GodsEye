import type { Config } from "tailwindcss";
import animate from "tailwindcss-animate";

const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        border: "hsl(var(--border))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        muted: { DEFAULT: "hsl(var(--muted))", foreground: "hsl(var(--muted-foreground))" },
        card: { DEFAULT: "hsl(var(--card))", foreground: "hsl(var(--foreground))" },
        primary: { DEFAULT: "hsl(var(--primary))", foreground: "hsl(var(--primary-foreground))" },
        // GodsEye dark neo-brutalism: black outlines, hard shadows, four loud tile colours.
        ink: "#0B0B0C", // outlines, shadows, text on bright tiles
        frame: "#0B0B0C",
        panel: "#17171B", // page
        chip: "#34343D", // resting buttons and tags
        tab: "#34343D",
        cream: "#FFFBE6", // raised / selected
        lilac: "#C77DFF", // purple tile
        violet: { DEFAULT: "#B565FF" },
        accent: "#D9A6FF", // links and highlights on dark
        lime: "#D4EC00",
        coral: "#FF7B7B",
        sun: "#FFC83D",
        win: "#D4EC00",
        loss: "#FF7B7B",
      },
      fontFamily: {
        sans: ["var(--font-sans)", "system-ui", "sans-serif"],
        mono: ["var(--font-mono)", "ui-monospace", "monospace"],
      },
      boxShadow: {
        hard: "6px 6px 0 #0B0B0C",
        "hard-sm": "3px 3px 0 #0B0B0C",
      },
      keyframes: {
        pulsedot: { "0%,100%": { opacity: "1", transform: "scale(1)" }, "50%": { opacity: ".45", transform: "scale(.85)" } },
      },
      animation: { pulsedot: "pulsedot 1.6s ease-in-out infinite" },
    },
  },
  plugins: [animate],
};
export default config;
