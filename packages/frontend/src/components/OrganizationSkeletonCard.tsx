import React from 'react';

/**
 * Skeleton placeholder for an organization card while data is loading.
 * Uses the existing `glass-panel` styling to match UI and Tailwind `animate-pulse`.
 */
export function OrganizationSkeletonCard() {
  return (
    <div className="glass-panel p-6 animate-pulse" data-testid="organization-skeleton">
      <div className="h-4 bg-white/20 rounded w-3/4 mb-2" />
      <div className="h-3 bg-white/20 rounded w-1/2 mb-2" />
      <div className="h-3 bg-white/20 rounded w-2/3" />
    </div>
  );
}
