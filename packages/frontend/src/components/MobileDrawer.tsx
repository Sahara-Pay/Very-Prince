"use client";

import { useState, useEffect } from "react";
import { usePathname } from "next/navigation";
import Link from "next/link";
import type { ComponentType } from "react";
import {
  DASHBOARD_NAV_ACTIVE_INDICATOR_CLASS,
  DASHBOARD_NAV_ICON_CLASS,
  getDashboardNavItemClassName,
} from "./dashboardNavigationStyles";
import { setDashboardScrollLock } from "./dashboardScrollLock";

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

// ── Hamburger Icon ────────────────────────────────────────────────────────────

function HamburgerIcon({
  className = "",
  isOpen,
}: {
  className?: string;
  isOpen: boolean;
}) {
  return (
    <svg
      className={className}
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={2}
    >
      {isOpen ? (
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M6 18L18 6M6 6l12 12"
        />
      ) : (
        <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" />
      )}
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

// ── Mobile Drawer Component ───────────────────────────────────────────────────

export function MobileDrawer() {
  const pathname = usePathname();
  const [isOpen, setIsOpen] = useState(false);

  /**
   * Close drawer when route changes
   */
  useEffect(() => {
    setIsOpen(false);
  }, [pathname]);

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

  /**
   * Prevent body scroll when drawer is open
   */
  useEffect(() => {
    const body = document.body;
    setDashboardScrollLock(body, isOpen);

    return () => {
      setDashboardScrollLock(body, false);
    };
  }, [isOpen]);

  return (
    <>
      {/* ── Hamburger Button (visible on mobile only) ────────────────────────── */}
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="fixed top-4 left-4 lg:hidden z-40 inline-flex items-center justify-center w-10 h-10 rounded-lg bg-white/10 backdrop-blur-md border border-white/20 hover:bg-white/15 transition-all duration-200"
        aria-label="Toggle navigation menu"
        aria-expanded={isOpen}
      >
        <HamburgerIcon className="w-6 h-6 text-white" isOpen={isOpen} />
      </button>

      {/* ── Backdrop (closes drawer when clicked) ──────────────────────────────── */}
      {isOpen && (
        <div
          className="fixed inset-0 bg-black/40 backdrop-blur-sm z-20 lg:hidden"
          onClick={() => setIsOpen(false)}
          aria-hidden="true"
        />
      )}

      {/* ── Slide-Out Drawer ───────────────────────────────────────────────────── */}
      <aside
        className={`fixed left-0 top-0 h-screen w-64 border-r border-white/10 bg-white/10 backdrop-blur-md flex flex-col gap-6 px-6 py-8 z-30 lg:hidden transition-transform duration-300 ease-out ${
          isOpen ? "translate-x-0" : "-translate-x-full"
        }`}
        aria-label="Mobile navigation menu"
      >
        {/* ── Logo/Brand Section ────────────────────────────────────────────────── */}
        <div className="flex items-center justify-between mt-2">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-stellar-purple to-brand-500 flex items-center justify-center">
              <span className="text-white font-bold text-lg">VP</span>
            </div>
            <div>
              <h1 className="text-lg font-bold text-white">Very-prince</h1>
              <p className="text-xs text-white/60">v1.0</p>
            </div>
          </div>
          <button
            onClick={() => setIsOpen(false)}
            className="p-2 hover:bg-white/5 rounded-lg transition-colors"
            aria-label="Close navigation menu"
          >
            <HamburgerIcon className="w-5 h-5 text-white" isOpen={true} />
          </button>
        </div>

        {/* ── Navigation Links ──────────────────────────────────────────────────── */}
        <nav className="flex-1 space-y-2">
          {navLinks.map((link) => {
            const Icon = link.icon;
            const active = isActive(link.href);

            return (
              <Link
                key={link.href}
                href={link.href}
                onClick={() => setIsOpen(false)}
              >
                <div
                  className={getDashboardNavItemClassName(active)}
                >
                  {Icon && <Icon className={DASHBOARD_NAV_ICON_CLASS} />}
                  <span className="font-medium">{link.label}</span>
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
    </>
  );
}
