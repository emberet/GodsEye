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
        // GodsEye: soft warm greys, a dark frame and one purple.
        ink: "#1E1E21",
        frame: "#2A2A2F",
        panel: "#ECEAE5",
        chip: "#E2DFD8",
        tab: "#DCD9D2",
        lilac: "#C9B8FF",
        violet: { DEFAULT: "#8B63FF", deep: "#6A3FF5" },
        win: "#6A3FF5",
        loss: "#B0476A",
        amber: "#9A6A12",
      },
      fontFamily: {
        sans: ["var(--font-sans)", "system-ui", "sans-serif"],
        mono: ["var(--font-mono)", "ui-monospace", "monospace"],
      },
      borderRadius: { card: "28px", panel: "32px", frame: "44px" },
      keyframes: {
        pulsedot: { "0%,100%": { opacity: "1", transform: "scale(1)" }, "50%": { opacity: ".45", transform: "scale(.85)" } },
      },
      animation: { pulsedot: "pulsedot 1.6s ease-in-out infinite" },
    },
  },
  plugins: [animate],
};
export default config;
