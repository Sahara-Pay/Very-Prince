"use client";

/**
 * @file InstallPWABanner.tsx
 * @description A dismissable banner prompting users to install the Very-Prince
 * dashboard as a standalone PWA. Uses glassmorphism styling consistent with the
 * application design system.
 *
 * Behavior:
 * - Android/Chrome: Shows "Install" button that triggers native prompt
 * - iOS Safari: Shows manual instructions (Share → Add to Home Screen)
 * - Hidden when app is already running in standalone mode
 * - Remembers dismissal for 7 days via localStorage
 */

import { usePWAInstall } from "@/hooks/usePWAInstall";

export function InstallPWABanner() {
  const { canInstall, isIOS, hasNativePrompt, triggerInstall, dismiss } =
    usePWAInstall();

  if (!canInstall) return null;

  return (
    <div
      id="pwa-install-banner"
      role="banner"
      aria-label="Install application"
      className="fixed bottom-4 left-4 right-4 z-50 mx-auto max-w-lg animate-slide-up"
    >
      <div className="relative overflow-hidden rounded-2xl border border-white/15 bg-white/10 p-4 shadow-2xl backdrop-blur-xl">
        {/* Gradient accent bar */}
        <div className="absolute inset-x-0 top-0 h-[2px] bg-gradient-to-r from-indigo-500 via-purple-500 to-pink-500" />

        <div className="flex items-start gap-4">
          {/* App icon */}
          <div className="flex-shrink-0">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-600 to-violet-600 shadow-lg shadow-indigo-500/25">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="h-6 w-6 text-white"
              >
                <path d="M3 12l3-3 3 3" />
                <path d="M12 3l3 3 3-3" />
                <path d="M6 9v6a3 3 0 003 3h6a3 3 0 003-3V9" />
                <circle cx="12" cy="6" r="1" />
              </svg>
            </div>
          </div>

          {/* Content */}
          <div className="min-w-0 flex-1">
            <h3 className="text-sm font-semibold text-white">
              Install Very-Prince
            </h3>

            {isIOS ? (
              <p className="mt-1 text-xs leading-relaxed text-white/60">
                Tap{" "}
                <span className="inline-flex items-center gap-0.5">
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    viewBox="0 0 20 20"
                    fill="currentColor"
                    className="inline h-3.5 w-3.5 text-indigo-400"
                  >
                    <path
                      fillRule="evenodd"
                      d="M13.75 7h-3V3.66l1.95 2.1a.75.75 0 101.1-1.02l-3.25-3.5a.75.75 0 00-1.1 0L6.2 4.74a.75.75 0 001.1 1.02l1.95-2.1V7h-3A2.25 2.25 0 004 9.25v7.5A2.25 2.25 0 006.25 19h7.5A2.25 2.25 0 0016 16.75v-7.5A2.25 2.25 0 0013.75 7z"
                      clipRule="evenodd"
                    />
                  </svg>
                  <span className="font-medium text-indigo-400">Share</span>
                </span>{" "}
                then <span className="font-medium text-white/80">&quot;Add to Home Screen&quot;</span>
              </p>
            ) : (
              <p className="mt-1 text-xs text-white/60">
                Get quick access from your home screen — works offline too.
              </p>
            )}

            {/* Action buttons */}
            {hasNativePrompt && (
              <div className="mt-3 flex items-center gap-2">
                <button
                  id="pwa-install-button"
                  type="button"
                  onClick={triggerInstall}
                  className="rounded-lg bg-gradient-to-r from-indigo-600 to-violet-600 px-4 py-1.5 text-xs font-semibold text-white shadow-lg shadow-indigo-500/25 transition-all hover:shadow-indigo-500/40 hover:brightness-110 active:scale-95"
                >
                  Install
                </button>
                <button
                  id="pwa-dismiss-button"
                  type="button"
                  onClick={dismiss}
                  className="rounded-lg px-3 py-1.5 text-xs font-medium text-white/50 transition-colors hover:text-white/80"
                >
                  Not now
                </button>
              </div>
            )}

            {/* iOS only has dismiss */}
            {isIOS && (
              <div className="mt-3">
                <button
                  id="pwa-dismiss-button-ios"
                  type="button"
                  onClick={dismiss}
                  className="rounded-lg px-3 py-1.5 text-xs font-medium text-white/50 transition-colors hover:text-white/80"
                >
                  Got it
                </button>
              </div>
            )}
          </div>

          {/* Close button */}
          <button
            type="button"
            onClick={dismiss}
            className="flex-shrink-0 rounded-lg p-1 text-white/40 transition-colors hover:bg-white/10 hover:text-white/80"
            aria-label="Dismiss install prompt"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 20 20"
              fill="currentColor"
              className="h-4 w-4"
            >
              <path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}
