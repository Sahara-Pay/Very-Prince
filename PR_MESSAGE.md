# Implement Progressive Web App (PWA) manifest and service worker

Closes #[202]

## Overview
This PR implements full Progressive Web App (PWA) capabilities for the Very-Prince dashboard, allowing users to install the dashboard as a standalone application on mobile and desktop devices. 

## What changed
- **Icons**: Added properly branded PWA icons (192x192, 512x512, maskable, and Apple touch icon) replacing the blank placeholders.
- **Manifest**: Fully populated `manifest.json` with `id`, `scope`, categories, shortcuts, and screenshots for a richer native installation prompt.
- **Service Worker & Config**: Configured `next-pwa` in `next.config.mjs` to auto-generate the service worker with a branded offline fallback page (`offline.html`).
- **Install Hook & Banner**: Created a custom `usePWAInstall` hook to handle the `beforeinstallprompt` event and a responsive `InstallPWABanner` with glassmorphism styling to prompt users to install on Android and iOS (Safari).
- **Apple iOS Meta Tags**: Added required Apple PWA meta tags in the root layout for iOS home screen compatibility.

## Verification
- Verified the PWA installation prompt triggers correctly on supported browsers.
- Verified the offline fallback page is served when the network drops.
- Verified the manifest and service worker configurations build correctly via `npm run build`.
- Confirmed `Lighthouse` PWA audit passes for installability.
