/**
 * @file ErrorBoundary.test.tsx
 * @description Tests for the reusable ErrorBoundary component.
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ErrorBoundary } from './ErrorBoundary';

// A child component that throws during render when told to.
function Boom({ shouldThrow }: { shouldThrow: boolean }) {
  if (shouldThrow) {
    throw new Error('Kaboom test error');
  }
  return <div>All good</div>;
}

describe('ErrorBoundary', () => {
  // Silence the expected console.error from the boundary's componentDidCatch.
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders children when there is no error', () => {
    render(
      <ErrorBoundary>
        <Boom shouldThrow={false} />
      </ErrorBoundary>
    );
    expect(screen.getByText('All good')).toBeTruthy();
  });

  it('catches a render error and shows the fallback UI', () => {
    render(
      <ErrorBoundary>
        <Boom shouldThrow={true} />
      </ErrorBoundary>
    );
    expect(screen.getByText('Something went wrong')).toBeTruthy();
    expect(screen.queryByText('All good')).toBeNull();
  });

  it('recovers when the user clicks "Try Again"', () => {
    // Shared flag the child reads to decide whether to throw. The boundary
    // catches the first throw, the user clicks "Try Again" (reset), and on the
    // subsequent render the child no longer throws -> content shows.
    let shouldThrow = true;
    function ThrowingChild() {
      if (shouldThrow) throw new Error('Kaboom test error');
      return <div>Recovered content</div>;
    }

    render(
      <ErrorBoundary>
        <ThrowingChild />
      </ErrorBoundary>
    );
    expect(screen.getByText('Something went wrong')).toBeTruthy();

    // Fix the underlying condition, then click "Try Again".
    shouldThrow = false;
    fireEvent.click(screen.getByText('Try Again'));

    expect(screen.getByText('Recovered content')).toBeTruthy();
    expect(screen.queryByText('Something went wrong')).toBeNull();
  });

  it('renders a custom fallback if provided', () => {
    render(
      <ErrorBoundary fallback={<div>Custom fallback</div>}>
        <Boom shouldThrow={true} />
      </ErrorBoundary>
    );
    expect(screen.getByText('Custom fallback')).toBeTruthy();
    expect(screen.queryByText('Something went wrong')).toBeNull();
  });
});
