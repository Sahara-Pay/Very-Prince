const DASHBOARD_NAV_ITEM_BASE_CLASS =
  "flex items-center gap-3 px-4 py-3 rounded-xl transition-all duration-200";

const DASHBOARD_NAV_ITEM_ACTIVE_CLASS =
  "bg-gradient-to-r from-stellar-purple/50 to-brand-500/30 text-white shadow-lg shadow-stellar-purple/20 border border-stellar-purple/30";

const DASHBOARD_NAV_ITEM_INACTIVE_CLASS =
  "text-white/70 hover:text-white hover:bg-white/5 border border-transparent";

export const DASHBOARD_NAV_ICON_CLASS = "w-5 h-5 flex-shrink-0";

export const DASHBOARD_NAV_ACTIVE_INDICATOR_CLASS =
  "ml-auto w-1.5 h-1.5 rounded-full bg-gradient-to-r from-stellar-purple to-brand-500";

export function getDashboardNavItemClassName(isActive: boolean) {
  return [
    DASHBOARD_NAV_ITEM_BASE_CLASS,
    isActive ? DASHBOARD_NAV_ITEM_ACTIVE_CLASS : DASHBOARD_NAV_ITEM_INACTIVE_CLASS,
  ].join(" ");
}
