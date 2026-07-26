import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import { vi, describe, test, expect } from 'vitest';
import { DateRangePicker } from '../ui/DateRangePicker';

describe('DateRangePicker', () => {
  test('renders preset buttons successfully', () => {
    const handleChange = vi.fn();
    render(<DateRangePicker onChange={handleChange} />);

    expect(screen.getByRole('button', { name: 'All Time' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Last 7 Days' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Last 30 Days' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Last 90 Days' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Custom Range' })).toBeInTheDocument();
  });

  test('calls onChange with nulls when All Time is selected by default', () => {
    const handleChange = vi.fn();
    render(<DateRangePicker onChange={handleChange} />);

    expect(handleChange).toHaveBeenCalledWith({ fromDate: null, toDate: null });
  });

  test('calls onChange with correct date range when a preset is clicked', () => {
    const handleChange = vi.fn();
    render(<DateRangePicker onChange={handleChange} />);

    const button7d = screen.getByRole('button', { name: 'Last 7 Days' });
    fireEvent.click(button7d);

    expect(handleChange).toHaveBeenCalledTimes(2); // Initial 'all' + '7d'
    const lastCall = handleChange.mock.calls[1]![0];
    expect(lastCall.fromDate).toBeInstanceOf(Date);
    expect(lastCall.toDate).toBeInstanceOf(Date);
  });

  test('shows custom date inputs when Custom Range preset is clicked', () => {
    const handleChange = vi.fn();
    render(<DateRangePicker onChange={handleChange} />);

    const buttonCustom = screen.getByRole('button', { name: 'Custom Range' });
    fireEvent.click(buttonCustom);

    expect(screen.getByLabelText('From:')).toBeInTheDocument();
    expect(screen.getByLabelText('To:')).toBeInTheDocument();
  });

  test('triggers onChange when custom dates are filled correctly', () => {
    const handleChange = vi.fn();
    render(<DateRangePicker onChange={handleChange} />);

    const buttonCustom = screen.getByRole('button', { name: 'Custom Range' });
    fireEvent.click(buttonCustom);

    const fromInput = screen.getByLabelText('From:');
    const toInput = screen.getByLabelText('To:');

    fireEvent.change(fromInput, { target: { value: '2026-07-20' } });
    fireEvent.change(toInput, { target: { value: '2026-07-25' } });

    const lastCall = handleChange.mock.calls[handleChange.mock.calls.length - 1]![0];
    expect(lastCall.fromDate?.getFullYear()).toBe(2026);
    expect(lastCall.fromDate?.getMonth()).toBe(6); // July is 6
    expect(lastCall.fromDate?.getDate()).toBe(20);
    expect(lastCall.toDate?.getDate()).toBe(25);
  });

  test('shows validation error when start date is after end date', () => {
    const handleChange = vi.fn();
    render(<DateRangePicker onChange={handleChange} />);

    const buttonCustom = screen.getByRole('button', { name: 'Custom Range' });
    fireEvent.click(buttonCustom);

    const fromInput = screen.getByLabelText('From:');
    const toInput = screen.getByLabelText('To:');

    fireEvent.change(fromInput, { target: { value: '2026-07-25' } });
    fireEvent.change(toInput, { target: { value: '2026-07-20' } });

    expect(screen.getByRole('alert')).toHaveTextContent('Start date must be on or before end date');
  });
});
