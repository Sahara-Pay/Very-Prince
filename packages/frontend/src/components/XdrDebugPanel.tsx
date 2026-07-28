"use client";

import React, { useEffect, useState } from "react";

export interface XdrEvent {
  type: string;
  label?: string;
  xdr: string;
}

export function XdrDebugPanel({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const [events, setEvents] = useState<XdrEvent[]>([]);

  useEffect(() => {
    function handle(e: any) {
      const d = e.detail || {};
      setEvents((s) => [{ type: d.type ?? "unsigned", label: d.label, xdr: d.xdr ?? "" }, ...s].slice(0, 20));
    }

    window.addEventListener("very-prince:xdr-debug", handle as EventListener);
    return () => window.removeEventListener("very-prince:xdr-debug", handle as EventListener);
  }, []);

  if (!visible) return null;

  return (
    <div className="fixed right-4 top-16 z-50 w-[560px] max-w-full rounded-lg bg-black/80 border border-white/[0.06] p-4 text-sm">
      <div className="flex items-center justify-between mb-3">
        <strong>Raw XDR Debug</strong>
        <div>
          <button
            aria-label="Close XDR Debug panel"
            onClick={onClose}
            className="ml-2 px-2 py-1 rounded bg-white/5"
          >
            Close
          </button>
        </div>
      </div>

      {events.length === 0 ? (
        <div className="text-xs text-white/60">No XDRs captured yet.</div>
      ) : (
        <div className="space-y-2 max-h-96 overflow-auto">
          {events.map((ev, idx) => (
            <div key={idx} className="rounded bg-white/5 p-2">
              <div className="flex justify-between">
                <div className="text-xs text-white/80">{ev.label ?? ev.type}</div>
                <button
                  onClick={() => navigator.clipboard?.writeText(ev.xdr)}
                  className="text-xs ml-2 px-2 py-1 bg-white/5 rounded"
                >
                  Copy
                </button>
              </div>
              <pre className="text-xs break-all mt-2 leading-5">{ev.xdr}</pre>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default XdrDebugPanel;
