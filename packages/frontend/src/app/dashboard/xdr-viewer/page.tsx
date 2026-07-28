import { Suspense } from "react";
import { XdrStreamServer } from "@/components/xdr-stream";
import { XdrInputForm } from "./XdrInputForm";
import { XdrEnvelopeErrorBoundary } from "@/components/xdr-stream";
import {
  HeaderSkeleton,
  OperationSkeleton,
} from "@/components/xdr-stream/XdrStreamSkeletons";

export default async function XdrViewerPage({
  searchParams,
}: {
  searchParams: Promise<{ xdr?: string }>;
}) {
  const params = await searchParams;
  const xdr = params.xdr;

  return (
    <div className="mx-auto max-w-4xl space-y-8 p-6">
      <div>
        <h1 className="text-2xl font-bold text-white">XDR Stream Parser</h1>
        <p className="mt-1 text-sm text-white/60">
          Paste a Stellar XDR transaction envelope to decode it on the server
          and stream the parsed operations progressively to your browser.
        </p>
      </div>

      <div className="rounded-2xl border border-white/10 bg-white/5 p-6">
        <XdrInputForm />
      </div>

      {xdr ? (
        <XdrEnvelopeErrorBoundary xdr={xdr}>
          <Suspense
            fallback={
              <div className="space-y-4">
                <HeaderSkeleton />
                <div className="flex flex-wrap items-center gap-3 text-xs text-white/50 animate-pulse">
                  <span>Parsing XDR on server...</span>
                </div>
                {Array.from({ length: 3 }).map((_, i) => (
                  <OperationSkeleton key={i} />
                ))}
              </div>
            }
          >
            <XdrStreamServer key={xdr} xdr={xdr} />
          </Suspense>
        </XdrEnvelopeErrorBoundary>
      ) : (
        <div className="rounded-2xl border border-dashed border-white/10 bg-white/[0.02] p-8 text-center">
          <p className="text-sm text-white/40">
            Paste an XDR string above and click Parse &amp; Stream to decode it.
          </p>
        </div>
      )}
    </div>
  );
}
