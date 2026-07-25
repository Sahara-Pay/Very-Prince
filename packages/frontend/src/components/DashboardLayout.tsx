"use client";

import { ReactNode } from "react";
import { DashboardSidebar } from "./DashboardSidebar";
import { MobileDrawer } from "./MobileDrawer";
import { InstallPWABanner } from "./InstallPWABanner";

interface DashboardLayoutProps {
  children: ReactNode;
}

/**
 * @file DashboardLayout.tsx
 * @description Main dashboard layout component with responsive sidebar and mobile drawer.
 *
 * Features:
 * - Desktop: Fixed left sidebar with glassmorphic design
 * - Mobile: Hamburger menu with slide-out drawer
 * - Responsive padding/margin adjustments
 * - Proper z-index management for overlays
 * - Active route highlighting
 */
export function DashboardLayout({ children }: DashboardLayoutProps) {
  return (
    <div className="relative min-h-screen bg-gradient-radial">
      {/* ── Desktop Sidebar ────────────────────────────────────────────────────── */}
      <DashboardSidebar />

      {/* ── Mobile Drawer ────────────────────────────────────────────────────── */}
      <MobileDrawer />

      {/* ── Main Content Area ────────────────────────────────────────────────────── */}
      <main
        className="lg:ml-64 min-h-screen w-full transition-all duration-300"
        role="main"
      >
        {/* Content container with proper padding */}
        <div className="mx-auto w-full max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
          {children}
        </div>
      </main>

      {/* ── PWA Install Prompt ────────────────────────────────────────────────── */}
      <InstallPWABanner />
    </div>
  );
}
