import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import { vi, describe, test, expect, beforeEach } from 'vitest';
import { FundingHistoryChart } from '../FundingHistoryChart';

// Mock useQuery
vi.mock('@tanstack/react-query', () => ({
  useQuery: vi.fn(),
}));

import { useQuery } from '@tanstack/react-query';
const mockUseQuery = useQuery as ReturnType<typeof vi.fn>;

const mockData = [
  {
    id: '1',
    orgId: 'stellar',
    from: 'G123...',
    amountStroops: '10000000',
    amountXlm: '1.0000000',
    cumulativeStroops: '10000000',
    cumulativeXlm: '1.0000000',
    txHash: 'hash1',
    createdAt: '2026-07-10T12:00:00.000Z',
  },
  {
    id: '2',
    orgId: 'stellar',
    from: 'G456...',
    amountStroops: '20000000',
    amountXlm: '2.0000000',
    cumulativeStroops: '30000000',
    cumulativeXlm: '3.0000000',
    txHash: 'hash2',
    createdAt: '2026-07-20T12:00:00.000Z',
  },
];

describe('FundingHistoryChart', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('renders chart with title, total sum, and date range picker', () => {
    mockUseQuery.mockReturnValue({
      data: mockData,
      error: null,
      isLoading: false,
    });

    render(<FundingHistoryChart orgId="stellar" />);

    expect(screen.getByText('Funding History')).toBeInTheDocument();
    expect(screen.getByText('3.00')).toBeInTheDocument(); // total cumulative XLM (yMax)
    expect(screen.getByRole('button', { name: 'All Time' })).toBeInTheDocument();
  });

  test('renders loading state correctly', () => {
    mockUseQuery.mockReturnValue({
      data: null,
      error: null,
      isLoading: true,
    });

    const { container } = render(<FundingHistoryChart orgId="stellar" />);
    expect(container.firstChild).toHaveClass('animate-pulse');
  });

  test('renders error state correctly', () => {
    mockUseQuery.mockReturnValue({
      data: null,
      error: new Error('Failed to fetch'),
      isLoading: false,
    });

    render(<FundingHistoryChart orgId="stellar" />);
    expect(screen.getByText('Failed to load funding history')).toBeInTheDocument();
  });

  test('filters points and updates chart when date range is selected', () => {
    mockUseQuery.mockReturnValue({
      data: mockData,
      error: null,
      isLoading: false,
    });

    const { container } = render(<FundingHistoryChart orgId="stellar" />);

    // Custom Range preset selection
    const customBtn = screen.getByRole('button', { name: 'Custom Range' });
    fireEvent.click(customBtn);

    const fromInput = screen.getByLabelText('From:');
    const toInput = screen.getByLabelText('To:');

    // Filter to only second point (July 20)
    fireEvent.change(fromInput, { target: { value: '2026-07-15' } });
    fireEvent.change(toInput, { target: { value: '2026-07-25' } });

    // With only one point, yMax (total) should be 3.00 (valXlm of point 2)
    expect(screen.getByText('3.00')).toBeInTheDocument();

    // Verify coordinates array size and visual elements rendered inside the SVG
    // An interactive transparent circle is rendered with r="14" for each visible point
    const circles = container.querySelectorAll('circle[r="14"]');
    expect(circles.length).toBe(1);
  });

  test('displays empty placeholder when filtered range has no events', () => {
    mockUseQuery.mockReturnValue({
      data: mockData,
      error: null,
      isLoading: false,
    });

    render(<FundingHistoryChart orgId="stellar" />);

    const customBtn = screen.getByRole('button', { name: 'Custom Range' });
    fireEvent.click(customBtn);

    const fromInput = screen.getByLabelText('From:');
    const toInput = screen.getByLabelText('To:');

    // Filter to a range with no events (August 2026)
    fireEvent.change(fromInput, { target: { value: '2026-08-01' } });
    fireEvent.change(toInput, { target: { value: '2026-08-10' } });

    expect(screen.getByText('No funding history found for the selected date range.')).toBeInTheDocument();
  });
});
