export const DASHBOARD_SCROLL_LOCK_CLASS = "overflow-hidden";

type ScrollLockTarget = {
  classList: Pick<DOMTokenList, "add" | "remove">;
};

export function setDashboardScrollLock(
  target: ScrollLockTarget,
  isLocked: boolean
) {
  if (isLocked) {
    target.classList.add(DASHBOARD_SCROLL_LOCK_CLASS);
    return;
  }

  target.classList.remove(DASHBOARD_SCROLL_LOCK_CLASS);
}
