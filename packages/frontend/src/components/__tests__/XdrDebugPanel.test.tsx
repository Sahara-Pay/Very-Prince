import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import DebugToggleClient from "../DebugToggleClient";

describe("XdrDebugPanel", () => {
  test("captures and displays dispatched XDR events when toggled on", async () => {
    render(<DebugToggleClient />);

    const toggle = screen.getByRole("button", { name: /toggle xdr debug/i });
    // open panel
    fireEvent.click(toggle);

    // dispatch a debug event
    const ev = new CustomEvent("very-prince:xdr-debug", {
      detail: { type: "unsigned", label: "test_tx", xdr: "TEST_XDR_BASE64" },
    });
    window.dispatchEvent(ev);

    // expect the xdr text to appear
    expect(await screen.findByText(/TEST_XDR_BASE64/)).toBeInTheDocument();
  });
});
