import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{js,ts,jsx,tsx,mdx}"],
  theme: {
    extend: {
      colors: {
        background: "#F7F7F7",
        surface: "#FFFFFF",
        card: "#F1F1F1",
        primary: "#2563EB",
        success: "#15803D",
        warning: "#B45309",
        error: "#DC2626",
        "text-primary": "#111111",
        "text-secondary": "#3F3F46",
        "text-muted": "#71717A"
      },
      fontFamily: {
        sans: ["-apple-system", "BlinkMacSystemFont", "Segoe UI", "Roboto", "sans-serif"]
      }
    }
  },
  plugins: []
};

export default config;
