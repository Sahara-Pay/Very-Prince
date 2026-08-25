"use client";

import React, {
  createContext,
  useContext,
  useState,
  useCallback,
  useMemo,
  useTransition,
  useEffect,
  ReactNode,
} from "react";

export interface BoundaryState {
  id: string;
  isCritical: boolean;
  isResolved: boolean;
}

export interface SuspenseOrchestratorContextType {
  registerBoundary: (id: string, isCritical?: boolean) => void;
  resolveBoundary: (id: string) => void;
  unregisterBoundary: (id: string) => void;
  isFullyResolved: boolean;
  isPending: boolean;
  registeredBoundaries: Record<string, BoundaryState>;
}

const SuspenseOrchestratorContext = createContext<SuspenseOrchestratorContextType | null>(null);

export function useSuspenseOrchestrator() {
  const context = useContext(SuspenseOrchestratorContext);
  if (!context) {
    throw new Error("useSuspenseOrchestrator must be used within a SuspenseOrchestratorProvider");
  }
  return context;
}

export function SuspenseOrchestratorProvider({
  children,
  fallback,
  minHeight = "min-h-[50vh]",
}: {
  children: ReactNode;
  fallback: ReactNode;
  minHeight?: string;
}) {
  const [boundaries, setBoundaries] = useState<Record<string, BoundaryState>>({});
  const [isFullyResolved, setIsFullyResolved] = useState(false);
  const [isPending, startTransition] = useTransition();

  const registerBoundary = useCallback((id: string, isCritical = true) => {
    if (!id || typeof id !== "string" || id.trim() === "") return;
    const cleanId = id.trim();
    setBoundaries((prev) => {
      if (prev[cleanId] && prev[cleanId].isCritical === isCritical) return prev;
      return {
        ...prev,
        [cleanId]: {
          id: cleanId,
          isCritical,
          isResolved: prev[cleanId]?.isResolved ?? false,
        },
      };
    });
  }, []);

  const resolveBoundary = useCallback((id: string) => {
    if (!id || typeof id !== "string" || id.trim() === "") return;
    const cleanId = id.trim();
    setBoundaries((prev) => {
      if (!prev[cleanId] || prev[cleanId].isResolved) return prev;
      return {
        ...prev,
        [cleanId]: {
          ...prev[cleanId],
          isResolved: true,
        },
      };
    });
  }, []);

  const unregisterBoundary = useCallback((id: string) => {
    if (!id || typeof id !== "string" || id.trim() === "") return;
    const cleanId = id.trim();
    setBoundaries((prev) => {
      if (!prev[cleanId]) return prev;
      const next = { ...prev };
      delete next[cleanId];
      return next;
    });
  }, []);

  // Determine whether all critical registered boundaries are resolved
  const checkCriticalResolved = useCallback((bMap: Record<string, BoundaryState>) => {
    const keys = Object.keys(bMap);
    if (keys.length === 0) return true;
    const criticalKeys = keys.filter((k) => bMap[k].isCritical);
    if (criticalKeys.length === 0) return true;
    return criticalKeys.every((k) => bMap[k].isResolved);
  }, []);

  useEffect(() => {
    const criticalResolved = checkCriticalResolved(boundaries);
    if (criticalResolved !== isFullyResolved) {
      startTransition(() => {
        setIsFullyResolved(criticalResolved);
      });
    }
  }, [boundaries, checkCriticalResolved, isFullyResolved]);

  const contextValue = useMemo(
    () => ({
      registerBoundary,
      resolveBoundary,
      unregisterBoundary,
      isFullyResolved,
      isPending,
      registeredBoundaries: boundaries,
    }),
    [registerBoundary, resolveBoundary, unregisterBoundary, isFullyResolved, isPending, boundaries]
  );

  return (
    <SuspenseOrchestratorContext.Provider value={contextValue}>
      <div className={`relative w-full ${minHeight} contain-layout`}>
        {/* Render children inside container; keep invisible & non-interactive until critical data resolves without layout shift */}
        <div
          className={`w-full transition-opacity duration-300 ease-in-out motion-reduce:transition-none ${
            isFullyResolved && !isPending ? "opacity-100" : "opacity-0 pointer-events-none"
          }`}
          aria-hidden={!isFullyResolved || isPending}
        >
          {children}
        </div>

        {/* Coordinated unified loader overlay matching layout until critical paint is ready */}
        {(!isFullyResolved || isPending) && (
          <div
            className="absolute inset-0 z-10 w-full bg-transparent flex flex-col justify-start"
            role="status"
            aria-live="polite"
            aria-busy="true"
            aria-label="Loading content"
          >
            {fallback}
          </div>
        )}
      </div>
    </SuspenseOrchestratorContext.Provider>
  );
}

export interface OrchestratedBoundaryProps {
  id: string;
  isCritical?: boolean;
  isReady: boolean;
  children?: ReactNode;
}

export function OrchestratedBoundary({
  id,
  isCritical = true,
  isReady,
  children,
}: OrchestratedBoundaryProps) {
  const { registerBoundary, resolveBoundary, unregisterBoundary } = useSuspenseOrchestrator();

  useEffect(() => {
    registerBoundary(id, isCritical);
    return () => {
      unregisterBoundary(id);
    };
  }, [id, isCritical, registerBoundary, unregisterBoundary]);

  useEffect(() => {
    if (isReady) {
      resolveBoundary(id);
    }
  }, [id, isReady, resolveBoundary]);

  return <>{children}</>;
}

/**
 * Hook for Web3 state mutations ensuring zero-layout-shift and maintaining 60FPS UI
 * responsiveness during heavy state changes by running mutations inside Concurrent React transitions.
 */
export function useZeroLayoutShiftMutation<T, R>(
  mutationFn: (args: T) => Promise<R>
) {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<Error | null>(null);

  const executeMutation = useCallback(
    async (args: T): Promise<R | undefined> => {
      setError(null);
      return new Promise<R | undefined>((resolve, reject) => {
        startTransition(() => {
          mutationFn(args)
            .then((res) => {
              resolve(res);
            })
            .catch((err) => {
              const e = err instanceof Error ? err : new Error(String(err));
              setError(e);
              reject(e);
            });
        });
      });
    },
    [mutationFn]
  );

  return {
    executeMutation,
    isPending,
    error,
  };
}
