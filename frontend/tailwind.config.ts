import type { Config } from "tailwindcss";

// Palette + typography mirror the design file exactly:
// /tmp/sealdex-design/extracted/sealdex/project/Sealdex Reveal Light.html
const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        paper: "#FAFAF7",
        card: "#FFFFFF",
        ink: "#14171C",
        ink2: "#2A2F38",
        dim: "#5A6070",
        muted: "#8C92A0",
        rule: "#E5E3DD",
        rule2: "#EEEDE7",
        accent: "#1E8B66",
        accentBg: "#EAF6F0",
        accent2: "#0F5E45",
        stamp: "#A53A3A",
      },
      fontFamily: {
        serif: ["var(--font-fraunces)", "ui-serif", "Georgia", "serif"],
        sans: ["var(--font-inter)", "ui-sans-serif", "system-ui"],
        mono: [
          "var(--font-jetbrains-mono)",
          "ui-monospace",
          "SFMono-Regular",
        ],
      },
    },
  },
  plugins: [],
};
export default config;
