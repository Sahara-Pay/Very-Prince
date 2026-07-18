/**
 * @file layout.tsx
 * @description Root layout for the very-prince Next.js application.
 *
 * Analytics: Plausible (privacy-first, GDPR-compliant, no cookies).
 * Custom events are fired via window.plausible() — see lib/analytics.ts.
 */

import type { Metadata, Viewport } from "next";
import Script from "next/script";
import { Toaster } from "sonner";
import { WalletProvider } from "@/contexts/WalletContext";
import { AuthProvider } from "@/contexts/AuthContext";
import DebugToggleClient from "@/components/DebugToggleClient";
import { TRPCProvider } from "@/trpc/provider";
import { Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-jetbrains-mono",
});



// ── SEO Metadata ──────────────────────────────────────────────────────────────

export const metadata: Metadata = {
  metadataBase: new URL(
    process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000"
  ),
  title: {
    template: "%s | very-prince",
    default: "very-prince – Stellar Payout Registry",
  },
  description:
    "A decentralized multi-organization payout registry built on Stellar Soroban. Track and claim contributor payouts transparently on-chain.",
  keywords: ["Stellar", "Soroban", "DeFi", "Open Source", "Payouts"],
  manifest: "/manifest.json",
  openGraph: {
    siteName: "very-prince",
    title: "very-prince — Stellar Payout Registry",
    description:
      "A decentralized multi-organization payout registry built on Stellar Soroban. Track and claim contributor payouts transparently on-chain.",
    type: "website",
    locale: "en_US",
  },
  twitter: {
    card: "summary_large_image",
    title: "very-prince — Stellar Payout Registry",
    description:
      "A decentralized multi-organization payout registry built on Stellar Soroban. Track and claim contributor payouts transparently on-chain.",
  },
};

// ── Viewport ──────────────────────────────────────────────────────────────────

export const viewport: Viewport = {
  themeColor: "#6366f1",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const plausibleDomain = process.env.NEXT_PUBLIC_PLAUSIBLE_DOMAIN ?? "";

  return (
    <html lang="en" translate="no" suppressHydrationWarning className={`${inter.variable} ${jetbrainsMono.variable} notranslate`}>
      <head>
        <meta name="google" content="notranslate" />
        {/* Plausible — privacy-first analytics, no cookies, GDPR-compliant */}
        {plausibleDomain && (
          <Script
            defer
            data-domain={plausibleDomain}
            src="https://plausible.io/js/script.js"
            strategy="afterInteractive"
          />
        )}
      </head>
      <body className="min-h-screen bg-stellar-blue font-sans text-white antialiased">
        <TRPCProvider>
          <WalletProvider>
            <AuthProvider>
              {/* Starfield ambient background */}
              <div
                aria-hidden="true"
                className="pointer-events-none fixed inset-0 bg-hero-pattern"
              />
              {/* Page content */}
              <div className="relative">{children}</div>
              <DebugToggleClient />

              {/* Toast notifications */}
              <Toaster
                position="top-right"
                expand={false}
                richColors
                closeButton
                theme="dark"
                toastOptions={{
                  style: {
                    background: "rgba(255, 255, 255, 0.1)",
                    backdropFilter: "blur(12px)",
                    border: "1px solid rgba(255, 255, 255, 0.2)",
                    color: "white",
                  },
                }}
              />
            </AuthProvider>
          </WalletProvider>
        </TRPCProvider>
      </body>
    </html>
  );
}
