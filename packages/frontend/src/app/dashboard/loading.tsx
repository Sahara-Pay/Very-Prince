export default function DashboardLoading() {
  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6">
      <div className="h-8 w-64 animate-pulse rounded-lg bg-white/10" />
      <div className="h-40 animate-pulse rounded-2xl bg-white/5" />
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="h-32 animate-pulse rounded-2xl bg-white/5" />
        <div className="h-32 animate-pulse rounded-2xl bg-white/5" />
      </div>
    </div>
  );
}