"use client";

import { useState, useEffect, useCallback } from "react";

/**
 * @file usePWAInstall.ts
 * @description Custom hook for managing PWA install prompt lifecycle.
 *
 * Handles:
 * - Capturing the `beforeinstallprompt` event (Android/Chrome)
 * - Detecting standalone display mode (already installed)
 * - Detecting iOS Safari for manual install instructions
 * - Tracking user dismissal with a 7-day localStorage cooldown
 * - Exposing a `triggerInstall()` method to programmatically prompt
 */

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
}

const DISMISS_KEY = "vp-pwa-install-dismissed";
const DISMISS_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export function usePWAInstall() {
  const [deferredPrompt, setDeferredPrompt] =
    useState<BeforeInstallPromptEvent | null>(null);
  const [isInstalled, setIsInstalled] = useState(false);
  const [isIOS, setIsIOS] = useState(false);
  const [isDismissed, setIsDismissed] = useState(false);

  // ── Detect platform & install state on mount ──────────────────────────────
  useEffect(() => {
    // Check if already running as standalone PWA
    const isStandalone =
      window.matchMedia("(display-mode: standalone)").matches ||
      (navigator as unknown as { standalone?: boolean }).standalone === true;
    setIsInstalled(isStandalone);

    // Detect iOS Safari
    const ua = navigator.userAgent;
    const isIOSDevice =
      /iPad|iPhone|iPod/.test(ua) ||
      (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
    const isSafari = /Safari/.test(ua) && !/CriOS|FxiOS|Chrome/.test(ua);
    setIsIOS(isIOSDevice && isSafari);

    // Check localStorage for dismissal cooldown
    const dismissedAt = localStorage.getItem(DISMISS_KEY);
    if (dismissedAt) {
      const elapsed = Date.now() - parseInt(dismissedAt, 10);
      if (elapsed < DISMISS_COOLDOWN_MS) {
        setIsDismissed(true);
      } else {
        localStorage.removeItem(DISMISS_KEY);
      }
    }
  }, []);

  // ── Listen for beforeinstallprompt ─────────────────────────────────────────
  useEffect(() => {
    const handler = (e: Event) => {
      // Prevent the mini-infobar from appearing on mobile
      e.preventDefault();
      setDeferredPrompt(e as BeforeInstallPromptEvent);
    };

    window.addEventListener("beforeinstallprompt", handler);

    // Detect when the app is successfully installed
    const installedHandler = () => {
      setIsInstalled(true);
      setDeferredPrompt(null);
    };
    window.addEventListener("appinstalled", installedHandler);

    return () => {
      window.removeEventListener("beforeinstallprompt", handler);
      window.removeEventListener("appinstalled", installedHandler);
    };
  }, []);

  // ── Trigger install prompt ────────────────────────────────────────────────
  const triggerInstall = useCallback(async () => {
    if (!deferredPrompt) return false;

    try {
      await deferredPrompt.prompt();
      const { outcome } = await deferredPrompt.userChoice;

      if (outcome === "accepted") {
        setIsInstalled(true);
      }

      // Clear the deferred prompt regardless — it can only be used once
      setDeferredPrompt(null);
      return outcome === "accepted";
    } catch {
      return false;
    }
  }, [deferredPrompt]);

  // ── Dismiss handler ───────────────────────────────────────────────────────
  const dismiss = useCallback(() => {
    setIsDismissed(true);
    localStorage.setItem(DISMISS_KEY, Date.now().toString());
  }, []);

  // canInstall is true when we have a deferred prompt (Android/Chrome)
  // OR when on iOS Safari (manual instructions)
  const canInstall =
    !isInstalled && !isDismissed && (!!deferredPrompt || isIOS);

  return {
    /** Whether the install banner should be shown */
    canInstall,
    /** Whether the app is already installed / running standalone */
    isInstalled,
    /** Whether the user is on iOS Safari (needs manual instructions) */
    isIOS,
    /** Whether there's a native prompt available (Android/Chrome) */
    hasNativePrompt: !!deferredPrompt,
    /** Trigger the native install prompt. Returns true if accepted. */
    triggerInstall,
    /** Dismiss the install prompt for 7 days */
    dismiss,
  };
}
