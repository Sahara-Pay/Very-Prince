/**
 * @file error.tsx
 * @description Next.js error boundary for the Very-prince application.
 *
 * This error boundary catches runtime errors in the app directory and displays
 * a user-friendly fallback UI instead of a blank white screen. It includes:
 * - Glassmorphism-styled error UI
 * - "Try Again" button that triggers React reset()
 * - Translation of blockchain errors into user-friendly messages
 */

'use client';

import { useEffect } from 'react';
import { Button } from '@/components/ui/Button';
import { toast } from 'sonner';
import { PrinceErrorMessage } from "@very-prince/types";

// ── Error Types ──────────────────────────────────────────────────────────────

interface ErrorBoundaryProps {
  error: Error & { digest?: string };
  reset: () => void;
}

// ── Error Message Translation ───────────────────────────────────────────────────

function translateBlockchainError(error: Error): string {
  const errorMessage = error.message;

  // Check if the error message is one of our custom PrinceError messages
  const customMessages = Object.values(PrinceErrorMessage);
  if (customMessages.includes(errorMessage)) {
    return errorMessage;
  }

  const lowerMessage = errorMessage.toLowerCase();
  
  // Common Stellar/Soroban error patterns
  if (lowerMessage.includes('outofgas') || lowerMessage.includes('out of gas')) {
    return 'Transaction ran out of gas. Please try again with a higher gas limit.';
  }
  
  if (errorMessage.includes('hosterror')) {
    return 'Network connection error. Please check your internet connection and try again.';
  }
  
  if (errorMessage.includes('timeout') || errorMessage.includes('network')) {
    return 'Network timeout. The Stellar network may be busy. Please try again.';
  }
  
  if (errorMessage.includes('insufficient') || errorMessage.includes('balance')) {
    return 'Insufficient balance. Please check your account and try again.';
  }
  
  if (errorMessage.includes('freighter') || errorMessage.includes('wallet')) {
    return 'Wallet connection error. Please ensure Freighter is unlocked and try again.';
  }
  
  if (errorMessage.includes('unauthorized') || errorMessage.includes('auth')) {
    return 'Authorization error. Please check your wallet permissions and try again.';
  }
  
  // Fallback for unknown errors
  return 'An unexpected error occurred. Please try again or contact support if the problem persists.';
}

// ── Error Boundary Component ───────────────────────────────────────────────────

export default function ErrorBoundary({ error, reset }: ErrorBoundaryProps) {
  useEffect(() => {
    // Log the error to console for debugging
    console.error('Error caught by boundary:', error);
    
    // Show a toast notification for the error
    const userMessage = translateBlockchainError(error);
    toast.error(userMessage);
  }, [error]);

  const isBlockchainError = error.message.toLowerCase().includes('hosterror') ||
                           error.message.toLowerCase().includes('outofgas') ||
                           error.message.toLowerCase().includes('freighter') ||
                           error.message.toLowerCase().includes('wallet') ||
                           error.message.toLowerCase().includes('network');

  return (
    <div className="min-h-screen bg-stellar-blue flex items-center justify-center p-4">
      {/* Starfield ambient background */}
      <div
        aria-hidden="true"
        className="pointer-events-none fixed inset-0 bg-hero-pattern"
      />
      
      {/* Error content */}
      <div className="relative max-w-md w-full">
        {/* Glassmorphism container */}
        <div className="backdrop-blur-xl bg-white/10 border border-white/20 rounded-2xl p-8 shadow-2xl">
          {/* Error icon */}
          <div className="flex justify-center mb-6">
            <div className="w-16 h-16 rounded-full bg-red-500/20 flex items-center justify-center">
              <svg
                className="w-8 h-8 text-red-400"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
                />
              </svg>
            </div>
          </div>

          {/* Error title */}
          <h1 className="text-2xl font-bold text-white text-center mb-4">
            Something went wrong
          </h1>

          {/* Error description */}
          <div className="text-center mb-8">
            {isBlockchainError ? (
              <div className="space-y-3">
                <p className="text-white/80">
                  We encountered an issue with the blockchain connection or transaction.
                </p>
                <div className="backdrop-blur-sm bg-white/5 border border-white/10 rounded-lg p-3">
                  <p className="text-sm text-white/60 font-mono">
                    {translateBlockchainError(error)}
                  </p>
                </div>
              </div>
            ) : (
              <p className="text-white/80">
                An unexpected error occurred while loading the page. This has been logged
                and our team will investigate the issue.
              </p>
            )}
          </div>

          {/* Action buttons */}
          <div className="space-y-3">
            <Button
              onClick={reset}
              aria-label="Try again"
              className="w-full bg-white/20 hover:bg-white/30 text-white border border-white/30 backdrop-blur-sm"
            >
              Try Again
            </Button>
            
            {/* Additional options for blockchain errors */}
            {isBlockchainError && (
              <div className="grid grid-cols-2 gap-3">
                <Button
                  onClick={() => window.location.reload()}
                  variant="outline"
                  aria-label="Refresh the current page"
                  className="border-white/20 text-white/80 hover:bg-white/10"
                >
                  Refresh Page
                </Button>
                <Button
                  onClick={() => window.open('https://freighter.app', '_blank')}
                  variant="outline"
                  aria-label="Open Freighter wallet website"
                  className="border-white/20 text-white/80 hover:bg-white/10"
                >
                  Check Wallet
                </Button>
              </div>
            )}
          </div>

          {/* Error details (development only) */}
          {process.env.NODE_ENV === 'development' && (
            <details className="mt-6">
              <summary className="text-white/60 text-sm cursor-pointer hover:text-white/80">
                Error Details (Development)
              </summary>
              <div className="mt-3 p-3 bg-black/20 rounded-lg border border-white/10">
                <p className="text-xs text-white/60 font-mono break-all">
                  {error.message}
                </p>
                {error.digest && (
                  <p className="text-xs text-white/40 font-mono mt-2">
                    Digest: {error.digest}
                  </p>
                )}
              </div>
            </details>
          )}
        </div>

        {/* Help text */}
        <div className="text-center mt-6">
          <p className="text-white/60 text-sm">
            If this problem persists, please{' '}
            <a
              href="https://github.com/Zakky-Fat/Very-prince/issues"
              target="_blank"
              rel="noopener noreferrer"
              className="text-white/80 hover:text-white underline"
            >
              report an issue
            </a>
            .
          </p>
        </div>
      </div>
    </div>
  );
}
