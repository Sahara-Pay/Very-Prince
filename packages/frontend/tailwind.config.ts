import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      // ── Brand Palette ────────────────────────────────────────────────────
      // Deep space aesthetic with Stellar's characteristic blue/violet tones.
      colors: {
        brand: {
          50: "#f0f4ff",
          100: "#dce6ff",
          200: "#b9cdff",
          300: "#85aaff",
          400: "#4d7eff",
          500: "#1a52ff",
          600: "#0030f5",
          700: "#0026c2",
          800: "#00209e",
          900: "#001f7d",
          950: "#00114d",
        },
        stellar: {
          blue: "#0A0E27",
          purple: "#7B61FF",
          teal: "#00CDCC",
          light: "#E8ECF9",
        },
        glass: {
          surface: "rgba(255,255,255,0.12)",
          soft: "rgba(255,255,255,0.08)",
          border: "rgba(255,255,255,0.20)",
        },
      },

      // ── Typography ───────────────────────────────────────────────────────
      fontFamily: {
        sans: ["Inter", "system-ui", "sans-serif"],
        mono: ["JetBrains Mono", "Menlo", "monospace"],
      },

      // ── Animations ───────────────────────────────────────────────────────
      keyframes: {
        "fade-in": {
          "0%": { opacity: "0", transform: "translateY(8px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        shimmer: {
          "0%": { backgroundPosition: "-200% 0" },
          "100%": { backgroundPosition: "200% 0" },
        },
        "slide-up": {
          "0%": { opacity: "0", transform: "translateY(100%)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        pulse: {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: "0.5" },
        },
      },
      animation: {
        "fade-in": "fade-in 0.4s ease-out forwards",
        shimmer: "shimmer 2s infinite linear",
        "slide-up": "slide-up 0.4s cubic-bezier(0.16, 1, 0.3, 1) forwards",
        pulse: "pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite",
      },

      // ── Background Images ─────────────────────────────────────────────────
      backgroundImage: {
        "gradient-radial": "radial-gradient(var(--tw-gradient-stops))",
        "hero-pattern":
          "radial-gradient(ellipse at top, #7B61FF22 0%, transparent 60%), radial-gradient(ellipse at bottom right, #00CDCC11 0%, transparent 60%)",
      },

      // ── Glassmorphism Utilities ────────────────────────────────────────────
      blur: {
        xs: "2px",
        md: "18px",
        glass: "24px",
      },
      backgroundOpacity: {
        5: "0.05",
        7: "0.07",
        12: "0.12",
        18: "0.18",
        24: "0.24",
      },
    },
  },
  plugins: [],
};

export default config;
