"use client";

import React, { createContext, useContext, useState, useCallback, useMemo, ReactNode } from "react";
import React, { createContext, useContext, useState, useCallback, useMemo, useTransition } from "react";

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
export function SuspenseOrchestratorProvider({ children, fallback }: { children: React.ReactNode, fallback: React.ReactNode }) {
  const [registeredBoundaries, setRegisteredBoundaries] = useState<Set<string>>(new Set());
  const [resolvedBoundaries, setResolvedBoundaries] = useState<Set<string>>(new Set());
  const [isPending, startTransition] = useTransition();

  const registerBoundary = useCallback((id: string) => {
    setRegisteredBoundaries((prev) => {
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
    // Wrap the resolution in a transition so React coordinates the final render
    // and eliminates Cumulative Layout Shift.
    startTransition(() => {
      setResolvedBoundaries((prev) => {
        const next = new Set(prev);
        next.add(id);
        return next;
      });
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
    if (registeredBoundaries.size === 0) return false;
    for (const id of registeredBoundaries) {
      if (!resolvedBoundaries.has(id)) return false;
    }
    return true;
  }, [registeredBoundaries, resolvedBoundaries]);

  // If not all registered boundaries are resolved, we show the orchestrator fallback.
  // The actual children will render invisibly or behind the fallback if we want to fetch data,
  // but since we want to coordinate Suspense, we usually render children but hide them, or just rely on CSS.
  // A cleaner approach: render children but absolute position a loading overlay over it until fully resolved.
  return (
    <SuspenseOrchestratorContext.Provider value={{ registerBoundary, resolveBoundary, isFullyResolved }}>
      <div className="relative w-full h-full min-h-[50vh]">
        {/* The children render immediately so they can trigger data fetches and register themselves */}
        <div className={`transition-opacity duration-300 ${isFullyResolved && !isPending ? "opacity-100" : "opacity-0"}`}>
          {children}
        </div>
        
        {/* The coordinated fallback loader */}
        {(!isFullyResolved || isPending) && (
          <div className="absolute inset-0 z-50 flex items-center justify-center bg-transparent">
            {fallback}
          </div>
        )}
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
 * A wrapper for components that need to register with the orchestrator.
 * It simulates a Suspense boundary but registers with the Orchestrator instead of showing its own fallback.
 */
export function OrchestratedBoundary({ id, children, isReady }: { id: string, children: React.ReactNode, isReady: boolean }) {
  const { registerBoundary, resolveBoundary } = useSuspenseOrchestrator();

  // Register on mount
  React.useEffect(() => {
    registerBoundary(id);
  }, [id, registerBoundary]);

  // Resolve when ready
  React.useEffect(() => {
    if (isReady) {
      resolveBoundary(id);
    }
  }, [id, isReady, resolveBoundary]);

  return <>{children}</>;
}
