import { describe, expect, it } from "vitest";
import {
  DASHBOARD_SCROLL_LOCK_CLASS,
  setDashboardScrollLock,
} from "./dashboardScrollLock";

function createScrollLockTarget(initialClasses: string[] = []) {
  const classes = new Set(initialClasses);

  return {
    classes,
    target: {
      classList: {
        add(className: string) {
          classes.add(className);
        },
        remove(className: string) {
          classes.delete(className);
        },
      },
    },
  };
}

describe("setDashboardScrollLock", () => {
  it("adds the Tailwind overflow-hidden class when locked", () => {
    const { classes, target } = createScrollLockTarget();

    setDashboardScrollLock(target, true);

    expect(classes.has(DASHBOARD_SCROLL_LOCK_CLASS)).toBe(true);
  });

  it("removes the Tailwind overflow-hidden class when unlocked", () => {
    const { classes, target } = createScrollLockTarget([
      DASHBOARD_SCROLL_LOCK_CLASS,
    ]);

    setDashboardScrollLock(target, false);

    expect(classes.has(DASHBOARD_SCROLL_LOCK_CLASS)).toBe(false);
  });

  it("leaves unrelated body classes intact", () => {
    const { classes, target } = createScrollLockTarget([
      "font-sans",
      DASHBOARD_SCROLL_LOCK_CLASS,
    ]);

    setDashboardScrollLock(target, false);

    expect(classes.has("font-sans")).toBe(true);
  });
});
