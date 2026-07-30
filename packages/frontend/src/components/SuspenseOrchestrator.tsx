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
}: {
  children: ReactNode;
  fallback: ReactNode;
}) {
  const [boundaries, setBoundaries] = useState<Record<string, BoundaryState>>({});
  const [isFullyResolved, setIsFullyResolved] = useState(false);
  const [isPending, startTransition] = useTransition();

  const registerBoundary = useCallback((id: string, isCritical = true) => {
    setBoundaries((prev) => {
      if (prev[id] && prev[id].isCritical === isCritical) return prev;
      return {
        ...prev,
        [id]: {
          id,
          isCritical,
          isResolved: prev[id]?.isResolved ?? false,
        },
      };
    });
  }, []);

  const resolveBoundary = useCallback((id: string) => {
    setBoundaries((prev) => {
      if (prev[id]?.isResolved) return prev;
      return {
        ...prev,
        [id]: {
          id,
          isCritical: prev[id]?.isCritical ?? true,
          isResolved: true,
        },
      };
    });
  }, []);

  // Determine whether all critical registered boundaries are resolved
  const checkCriticalResolved = useCallback((bMap: Record<string, BoundaryState>) => {
    const keys = Object.keys(bMap);
    if (keys.length === 0) return false;
    const criticalKeys = keys.filter((k) => bMap[k].isCritical);
    if (criticalKeys.length === 0) return true;
    return criticalKeys.every((k) => bMap[k].isResolved);
  }, []);

  useEffect(() => {
    const criticalResolved = checkCriticalResolved(boundaries);
    if (criticalResolved && !isFullyResolved) {
      startTransition(() => {
        setIsFullyResolved(true);
      });
    }
  }, [boundaries, checkCriticalResolved, isFullyResolved]);

  const contextValue = useMemo(
    () => ({
      registerBoundary,
      resolveBoundary,
      isFullyResolved,
      isPending,
      registeredBoundaries: boundaries,
    }),
    [registerBoundary, resolveBoundary, isFullyResolved, isPending, boundaries]
  );

  return (
    <SuspenseOrchestratorContext.Provider value={contextValue}>
      <div className="relative w-full min-h-[50vh]">
        {/* Render children inside container; keep invisible & non-interactive until critical data resolves */}
        <div
          className={`w-full transition-opacity duration-300 ease-in-out ${
            isFullyResolved && !isPending ? "opacity-100" : "opacity-0 pointer-events-none"
          }`}
          aria-hidden={!isFullyResolved || isPending}
        >
          {children}
        </div>

        {/* Coordinated unified loader overlay matching layout until critical paint is ready */}
        {(!isFullyResolved || isPending) && (
          <div className="absolute inset-0 z-10 w-full bg-transparent" aria-busy="true">
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
  const { registerBoundary, resolveBoundary } = useSuspenseOrchestrator();

  useEffect(() => {
    registerBoundary(id, isCritical);
  }, [id, isCritical, registerBoundary]);

  useEffect(() => {
    if (isReady) {
      resolveBoundary(id);
    }
  }, [id, isReady, resolveBoundary]);

  return <>{children}</>;
}
