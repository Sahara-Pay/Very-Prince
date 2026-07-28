import React from "react";
import { render } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { GlassButton } from "../GlassButton";
import { GlassPanel } from "../GlassPanel";
import { OrganizationSkeletonCard } from "../OrganizationSkeletonCard";
import { EmptyMaintainersState } from "../EmptyMaintainersState";

describe("UI Components Snapshots", () => {
  describe("GlassButton", () => {
    it("matches snapshot for primary variant button", () => {
      const { asFragment } = render(
        <GlassButton variant="primary" onClick={vi.fn()}>
          Primary Button
        </GlassButton>
      );
      expect(asFragment()).toMatchSnapshot();
    });

    it("matches snapshot for secondary variant button", () => {
      const { asFragment } = render(
        <GlassButton variant="secondary" onClick={vi.fn()}>
          Secondary Button
        </GlassButton>
      );
      expect(asFragment()).toMatchSnapshot();
    });

    it("matches snapshot for primary variant link", () => {
      const { asFragment } = render(
        <GlassButton variant="primary" href="/dashboard">
          Link Button
        </GlassButton>
      );
      expect(asFragment()).toMatchSnapshot();
    });
  });

  describe("GlassPanel", () => {
    it("matches snapshot with custom class", () => {
      const { asFragment } = render(
        <GlassPanel className="custom-class">
          <div>Panel Content</div>
        </GlassPanel>
      );
      expect(asFragment()).toMatchSnapshot();
    });
  });

  describe("OrganizationSkeletonCard", () => {
    it("matches snapshot", () => {
      const { asFragment } = render(<OrganizationSkeletonCard />);
      expect(asFragment()).toMatchSnapshot();
    });
  });

  describe("EmptyMaintainersState", () => {
    it("matches snapshot", () => {
      const { asFragment } = render(
        <EmptyMaintainersState orgId="stellar-org" onAllocateClick={vi.fn()} />
      );
      expect(asFragment()).toMatchSnapshot();
    });
  });
});
