"use client";

import React from "react";

interface XdrStreamErrorBoundaryProps {
  children: React.ReactNode;
  operationIndex?: number;
}

interface XdrStreamErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

export class XdrStreamErrorBoundary extends React.Component<
  XdrStreamErrorBoundaryProps,
  XdrStreamErrorBoundaryState
> {
  constructor(props: XdrStreamErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): XdrStreamErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
    console.error(
      `XdrStreamErrorBoundary caught error${this.props.operationIndex !== undefined ? ` in operation #${this.props.operationIndex}` : ""}:`,
      error,
      errorInfo,
    );
  }

  render(): React.ReactNode {
    if (this.state.hasError) {
      const idx = this.props.operationIndex;
      return (
        <div
          role="alert"
          className="rounded-2xl border border-red-500/20 bg-red-500/5 p-5 animate-fade-in"
        >
          <div className="flex items-center gap-3">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-red-500/10 text-sm">
              ⚠️
            </span>
            <span className="text-sm font-medium text-red-300">
              {idx !== undefined
                ? `Operation #${idx} failed to decode`
                : "XDR decode error"}
            </span>
          </div>
          <p className="mt-2 text-xs text-red-300/70">
            {this.state.error?.message ?? "This operation could not be parsed."}
          </p>
        </div>
      );
    }

    return this.props.children;
  }
}

export class XdrEnvelopeErrorBoundary extends React.Component<
  { children: React.ReactNode; xdr?: string },
  XdrStreamErrorBoundaryState
> {
  constructor(props: { children: React.ReactNode; xdr?: string }) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): XdrStreamErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
    console.error("XdrEnvelopeErrorBoundary caught error:", error, errorInfo);
  }

  render(): React.ReactNode {
    if (this.state.hasError) {
      return (
        <div
          role="alert"
          className="rounded-2xl border border-red-500/20 bg-red-500/5 p-8 text-center animate-fade-in"
        >
          <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-red-500/10">
            <span className="text-2xl">🚫</span>
          </div>
          <h3 className="text-lg font-semibold text-red-300">
            Invalid XDR Payload
          </h3>
          <p className="mt-2 text-sm text-red-300/70">
            The provided XDR string could not be decoded. Ensure it is a valid
            Base64-encoded Stellar transaction envelope.
          </p>
          {this.state.error?.message && (
            <pre className="mx-auto mt-4 max-w-lg overflow-auto rounded-xl border border-white/5 bg-black/30 p-3 text-left font-mono text-xs text-red-300/60">
              {this.state.error.message}
            </pre>
          )}
          {this.props.xdr && (
            <div className="mt-4">
              <details className="text-left">
                <summary className="cursor-pointer text-xs text-white/40 hover:text-white/60 transition-colors">
                  Show raw XDR
                </summary>
                <pre className="mt-2 max-h-32 overflow-auto rounded-xl border border-white/5 bg-black/30 p-3 font-mono text-[10px] text-white/40 break-all">
                  {this.props.xdr}
                </pre>
              </details>
            </div>
          )}
        </div>
      );
    }

    return this.props.children;
  }
}
