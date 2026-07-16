"use client";

import React, { useState } from "react";
import XdrDebugPanel from "./XdrDebugPanel";

export default function DebugToggleClient() {
  const [visible, setVisible] = useState(false);

  return (
    <>
      <button
        aria-label="Toggle XDR Debug"
        onClick={() => setVisible((v) => !v)}
        className="fixed right-4 top-4 z-50 rounded-full bg-white/6 p-2 hover:bg-white/10"
      >
        Debug
      </button>
      <XdrDebugPanel visible={visible} onClose={() => setVisible(false)} />
    </>
  );
}
