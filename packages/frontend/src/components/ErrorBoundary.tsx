/**
 * @file ErrorBoundary.tsx
 * @description Reusable class-based React error boundary.
 *
 * Next.js `error.tsx` only catches errors thrown in its route segment — it
 * does NOT catch render errors in the root layout or provide a reusable
 * boundary you can drop around any subtree. This component fills that gap:
 * wrap any part of the app tree and it will catch render-phase errors, show a
 * fallback UI, and offer a "Try Again" reset.
 */
'use client';

import React from 'react';

interface ErrorBoundaryProps {
    children: React.ReactNode;
    fallback?: React.ReactNode;
    onReset?: () => void;
}

interface ErrorBoundaryState {
    hasError: boolean;
    error: Error | null;
}

export class ErrorBoundary extends React.Component<
    ErrorBoundaryProps,
    ErrorBoundaryState
> {
    constructor(props: ErrorBoundaryProps) {
        super(props);
        this.state = { hasError: false, error: null };
        this.handleReset = this.handleReset.bind(this);
    }

    static getDerivedStateFromError(error: Error): ErrorBoundaryState {
        return { hasError: true, error };
    }

    override componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
        // Surface the error for debugging / observability.
        console.error('ErrorBoundary caught an error:', error, errorInfo);
    }

    handleReset(): void {
        this.setState({ hasError: false, error: null });
        this.props.onReset?.();
    }

    override render(): React.ReactNode {
        if (this.state.hasError) {
            if (this.props.fallback) {
                return this.props.fallback;
            }

            const isDev = process.env.NODE_ENV !== 'production';
            const message =
                this.state.error?.message ?? 'An unexpected error occurred.';

            return (
                <div className="min-h-screen bg-stellar-blue flex items-center justify-center p-4">
                    <div
                        aria-hidden="true"
                        className="pointer-events-none fixed inset-0 bg-hero-pattern"
                    />
                    <div className="relative max-w-md w-full">
                        <div className="backdrop-blur-xl bg-white/10 border border-white/20 rounded-2xl p-8 shadow-2xl">
                            <div className="flex justify-center mb-6">
                                <div className="w-14 h-14 rounded-full bg-red-500/20 flex items-center justify-center">
                                    <svg
                                        xmlns="http://www.w3.org/2000/svg"
                                        className="w-7 h-7 text-red-400"
                                        viewBox="0 0 24 24"
                                        fill="none"
                                        stroke="currentColor"
                                        strokeWidth="2"
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                        aria-hidden="true"
                                    >
                                        <path d="M12 9v4" />
                                        <path d="M12 17h.01" />
                                        <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
                                    </svg>
                                </div>
                            </div>
                            <h2 className="text-xl font-semibold text-white text-center mb-2">
                                Something went wrong
                            </h2>
                            <p className="text-white/70 text-center text-sm mb-6">
                                {isDev
                                    ? message
                                    : 'We hit an unexpected error. Please try again.'}
                            </p>
                            {isDev && this.state.error?.stack && (
                                <pre className="text-xs text-red-300/80 bg-black/30 rounded-lg p-3 mb-6 overflow-auto max-h-40">
                                    {this.state.error.stack}
                                </pre>
                            )}
                            <div className="flex justify-center">
                                <button
                                    type="button"
                                    onClick={this.handleReset}
                                    className="inline-flex items-center justify-center rounded-lg bg-brand-purple px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-brand-purple/90 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-purple focus-visible:ring-offset-2 focus-visible:ring-offset-stellar-blue"
                                >
                                    Try Again
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            );
        }

        return this.props.children;
    }
}

export default ErrorBoundary;
