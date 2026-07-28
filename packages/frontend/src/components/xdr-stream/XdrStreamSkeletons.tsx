export function OperationSkeleton() {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/5 p-5 animate-pulse">
      <div className="flex items-center gap-3 mb-4">
        <div className="h-8 w-8 rounded-lg bg-white/10" />
        <div className="h-5 w-32 rounded bg-white/10" />
        <div className="ml-auto h-4 w-16 rounded bg-white/10" />
      </div>
      <div className="space-y-2">
        <div className="h-3 w-full rounded bg-white/5" />
        <div className="h-3 w-3/4 rounded bg-white/5" />
        <div className="h-3 w-1/2 rounded bg-white/5" />
      </div>
    </div>
  );
}

export function HeaderSkeleton() {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/5 p-5 animate-pulse">
      <div className="flex items-center gap-3 mb-4">
        <div className="h-6 w-6 rounded bg-white/10" />
        <div className="h-5 w-48 rounded bg-white/10" />
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="space-y-1">
            <div className="h-3 w-16 rounded bg-white/10" />
            <div className="h-4 w-24 rounded bg-white/10" />
          </div>
        ))}
      </div>
    </div>
  );
}

export function StatsBarSkeleton() {
  return (
    <div className="flex gap-4 animate-pulse">
      {Array.from({ length: 3 }).map((_, i) => (
        <div key={i} className="h-4 w-20 rounded bg-white/10" />
      ))}
    </div>
  );
}
