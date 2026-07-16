import { describe, expect, it } from "vitest";
import { getDashboardNavItemClassName } from "./dashboardNavigationStyles";

describe("getDashboardNavItemClassName", () => {
  it("uses active dashboard nav Tailwind classes", () => {
    const className = getDashboardNavItemClassName(true);

    expect(className).toContain("flex items-center gap-3");
    expect(className).toContain("bg-gradient-to-r");
    expect(className).toContain("border-stellar-purple/30");
  });

  it("uses inactive dashboard nav Tailwind classes", () => {
    const className = getDashboardNavItemClassName(false);

    expect(className).toContain("flex items-center gap-3");
    expect(className).toContain("text-white/70");
    expect(className).toContain("border-transparent");
  });
});
