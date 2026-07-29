/**
 * @file dashboard/page.tsx
 * @description PayoutRegistry dashboard.
 */

import { DashboardContent } from "@/components/DashboardContent";

interface DashboardPageProps {
  searchParams: {
    org?: string;
  };
}

export default function DashboardPage({ searchParams }: DashboardPageProps) {
  return (
    <div className="flex min-h-screen flex-col">
      <DashboardContent initialOrgId={searchParams.org} />
    </div>
  );
}
