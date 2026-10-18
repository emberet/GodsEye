import type { Config } from "tailwindcss";
import animate from "tailwindcss-animate";

const config: Config = {
  darkMode: "class",
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
        win: "#00FF88",
        loss: "#FF4444",
        amber: "#FFC24B",
        w95: { gray: "#c0c0c0", light: "#ffffff", dark: "#808080", navy: "#000080", blue: "#1084d0" },
      },
      fontFamily: {
        pixel: ["var(--font-pixel)", "monospace"],
        mono: ["var(--font-mono)", "ui-monospace", "monospace"],
      },
      keyframes: {
        pulsedot: { "0%,100%": { opacity: "1", transform: "scale(1)" }, "50%": { opacity: ".35", transform: "scale(.8)" } },
        blink: { "0%,49%": { opacity: "1" }, "50%,100%": { opacity: "0" } },
      },
      animation: { pulsedot: "pulsedot 1.4s ease-in-out infinite", blink: "blink 1s step-end infinite" },
    },
  },
  plugins: [animate],
};
export default config;
