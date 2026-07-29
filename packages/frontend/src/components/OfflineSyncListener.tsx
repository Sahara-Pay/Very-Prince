"use client";

import { useEffect } from "react";
import { toast } from "sonner";

/**
 * Listens for messages from the Service Worker (e.g., when a background 
 * sync replay fails due to an expired auth token) and notifies the user.
 */
export default function OfflineSyncListener() {
  useEffect(() => {
    if (typeof window === "undefined" || !("serviceWorker" in navigator)) return;

    const handleMessage = (event: MessageEvent) => {
      if (event.data && event.data.type === "SYNC_FAILED_AUTH") {
        toast.error("Offline sync failed", {
          description: "Your session expired while offline. Please log in again to save your pending changes.",
          duration: 10000,
        });
      }
    };

    navigator.serviceWorker.addEventListener("message", handleMessage);
    
    return () => {
      navigator.serviceWorker.removeEventListener("message", handleMessage);
    };
  }, []);

  return null;
}
