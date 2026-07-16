"use client";

import { usePathname } from "next/navigation";
import Link from "next/link";
import type { ComponentType } from "react";
import {
  DASHBOARD_NAV_ACTIVE_INDICATOR_CLASS,
  DASHBOARD_NAV_ICON_CLASS,
  getDashboardNavItemClassName,
} from "./dashboardNavigationStyles";

interface NavLink {
  label: string;
  href: string;
  icon?: ComponentType<{ className?: string }>;
}

// ── Icon Components (inline SVG icons) ────────────────────────────────────────

function OverviewIcon({ className = "" }: { className?: string }) {
  return (
    <svg
      className={className}
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={2}
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M3 12l2-3m0 0l7-4 7 4M5 9v10a1 1 0 001 1h12a1 1 0 001-1V9m-9 4l4-2m0 0l4 2m-4-2v10"
      />
    </svg>
  );
}

function OrganizationIcon({ className = "" }: { className?: string }) {
  return (
    <svg
      className={className}
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={2}
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5.581m0 0H9m5.419 0C17.571 19.952 16.334 18.706 15.581 17m0 0a6.5 6.5 0 10-11.006 3.584m11.006-3.584l1.5 1.5"
      />
    </svg>
  );
}

function PayoutIcon({ className = "" }: { className?: string }) {
  return (
    <svg
      className={className}
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={2}
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
      />
    </svg>
  );
}

function SettingsIcon({ className = "" }: { className?: string }) {
  return (
    <svg
      className={className}
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={2}
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
      />
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
      />
    </svg>
  );
}

// ── Navigation Configuration ──────────────────────────────────────────────────

const navLinks: NavLink[] = [
  { label: "Overview", href: "/dashboard", icon: OverviewIcon },
  { label: "Organizations", href: "/dashboard/org", icon: OrganizationIcon },
  { label: "My Payouts", href: "/dashboard/payouts", icon: PayoutIcon },
  { label: "Settings", href: "/dashboard/settings", icon: SettingsIcon },
];

// ── Sidebar Component ─────────────────────────────────────────────────────────

export function DashboardSidebar() {
  const pathname = usePathname();

  /**
   * Determine if a link is active
   * Handles both exact match and nested routes
   */
  const isActive = (href: string) => {
    if (href === "/dashboard") {
      return pathname === "/dashboard";
    }
    return pathname.startsWith(href);
  };

  return (
    <aside
      className="fixed left-0 top-0 h-screen w-64 border-r border-white/10 bg-white/10 backdrop-blur-md hidden lg:flex flex-col gap-8 px-6 py-8 z-30"
      aria-label="Dashboard navigation"
    >
      {/* ── Logo/Brand Section ────────────────────────────────────────────────── */}
      <div className="flex items-center justify-start">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-stellar-purple to-brand-500 flex items-center justify-center">
            <span className="text-white font-bold text-lg">VP</span>
          </div>
          <div>
            <h1 className="text-lg font-bold text-white">Very-prince</h1>
            <p className="text-xs text-white/60">v1.0</p>
          </div>
        </div>
      </div>

      {/* ── Navigation Links ──────────────────────────────────────────────────── */}
      <nav className="flex-1 space-y-2">
        {navLinks.map((link) => {
          const Icon = link.icon;
          const active = isActive(link.href);

          return (
            <Link key={link.href} href={link.href}>
              <div
                className={getDashboardNavItemClassName(active)}
              >
                {Icon && <Icon className={DASHBOARD_NAV_ICON_CLASS} />}
                <span className="font-medium text-sm">{link.label}</span>
                {active && (
                  <div className={DASHBOARD_NAV_ACTIVE_INDICATOR_CLASS} />
                )}
              </div>
            </Link>
          );
        })}
      </nav>

      {/* ── Footer Section ────────────────────────────────────────────────────── */}
      <div className="border-t border-white/10 pt-4 space-y-2">
        <p className="text-xs text-white/50 px-4">
          A decentralized payout registry built on Stellar Soroban
        </p>
      </div>
    </aside>
  );
}
