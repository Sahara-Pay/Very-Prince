"use client";

import React, { createContext, useContext, useState, useCallback, useMemo, ReactNode } from "react";

interface SuspenseOrchestratorContextType {
  registerBoundary: (id: string) => void;
  resolveBoundary: (id: string) => void;
  isFullyResolved: boolean;
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
  fallback 
}: { 
  children: ReactNode; 
  fallback: ReactNode;
}) {
  const [registered, setRegistered] = useState<Set<string>>(new Set());
  const [resolved, setResolved] = useState<Set<string>>(new Set());

  const registerBoundary = useCallback((id: string) => {
    setRegistered((prev) => {
      if (prev.has(id)) return prev;
      const next = new Set(prev);
      next.add(id);
      return next;
    });
  }, []);

  const resolveBoundary = useCallback((id: string) => {
    setResolved((prev) => {
      if (prev.has(id)) return prev;
      const next = new Set(prev);
      next.add(id);
      return next;
    });
  }, []);

  const isFullyResolved = useMemo(() => {
    if (registered.size === 0) return false;
    for (const id of Array.from(registered)) {
      if (!resolved.has(id)) return false;
    }
    return true;
  }, [registered, resolved]);

  return (
    <SuspenseOrchestratorContext.Provider value={{ registerBoundary, resolveBoundary, isFullyResolved }}>
      {/* Show the generic unified fallback until everything is fully resolved */}
      {!isFullyResolved && (
        <div className="absolute inset-0 z-10 w-full" aria-hidden="true">
          {fallback}
        </div>
      )}
      
      {/* Render the actual children but keep them invisible until resolved to prevent CLS */}
      <div 
        className="w-full transition-opacity duration-300 ease-in-out" 
        style={{ 
          opacity: isFullyResolved ? 1 : 0,
          pointerEvents: isFullyResolved ? "auto" : "none",
          position: isFullyResolved ? "relative" : "absolute",
          visibility: isFullyResolved ? "visible" : "hidden"
        }}
      >
        {children}
      </div>
    </SuspenseOrchestratorContext.Provider>
  );
}

/**
 * A wrapper component that registers with the orchestrator.
 * Render this component twice per boundary:
 * 1. Inside the Suspense fallback (with isReady={false})
 * 2. Inside the actual resolved component (with isReady={true})
 */
export function OrchestratedBoundary({ 
  id, 
  isReady, 
  children 
}: { 
  id: string; 
  isReady: boolean; 
  children?: ReactNode;
}) {
  const { registerBoundary, resolveBoundary } = useSuspenseOrchestrator();

  React.useEffect(() => {
    if (!isReady) {
      registerBoundary(id);
    } else {
      // It's ready, but we also register it just in case it mounted ready immediately
      registerBoundary(id);
      resolveBoundary(id);
    }
  }, [id, isReady, registerBoundary, resolveBoundary]);

  return <>{children}</>;
}
