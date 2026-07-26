'use client';

import React, { useState, useEffect } from 'react';

export interface DateRange {
  fromDate: Date | null;
  toDate: Date | null;
}

export interface DateRangePickerProps {
  onChange: (range: DateRange) => void;
  className?: string;
}

type PresetType = 'all' | '7d' | '30d' | '90d' | 'custom';

const formatDateToInput = (date: Date | null): string => {
  if (!date) return '';
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
};

const parseInputDate = (value: string, isEnd: boolean): Date | null => {
  if (!value) return null;
  const [yyyy, mm, dd] = value.split('-').map(Number);
  if (!yyyy || isNaN(mm) || isNaN(dd)) return null;
  if (isEnd) {
    return new Date(yyyy, mm - 1, dd, 23, 59, 59, 999);
  }
  return new Date(yyyy, mm - 1, dd, 0, 0, 0, 0);
};

const getPresetRange = (preset: Exclude<PresetType, 'custom'>): DateRange => {
  const now = new Date();
  const to = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);

  if (preset === '7d') {
    const from = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 7, 0, 0, 0, 0);
    return { fromDate: from, toDate: to };
  }
  if (preset === '30d') {
    const from = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 30, 0, 0, 0, 0);
    return { fromDate: from, toDate: to };
  }
  if (preset === '90d') {
    const from = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 90, 0, 0, 0, 0);
    return { fromDate: from, toDate: to };
  }
  return { fromDate: null, toDate: null };
};

export function DateRangePicker({ onChange, className = '' }: DateRangePickerProps) {
  const [activePreset, setActivePreset] = useState<PresetType>('all');
  const [customStart, setCustomStart] = useState<string>('');
  const [customEnd, setCustomEnd] = useState<string>('');
  const [validationError, setValidationError] = useState<string | null>(null);

  // Trigger onChange when activePreset changes (except custom)
  useEffect(() => {
    if (activePreset !== 'custom') {
      setValidationError(null);
      const range = getPresetRange(activePreset as Exclude<PresetType, 'custom'>);
      onChange(range);
    }
  }, [activePreset, onChange]);

  // Handle custom date field changes
  const handleCustomChange = (startStr: string, endStr: string) => {
    setCustomStart(startStr);
    setCustomEnd(endStr);

    const fromDate = parseInputDate(startStr, false);
    const toDate = parseInputDate(endStr, true);

    if (fromDate && toDate && fromDate > toDate) {
      setValidationError('Start date must be on or before end date');
      onChange({ fromDate: null, toDate: null });
    } else {
      setValidationError(null);
      if (fromDate || toDate) {
        onChange({ fromDate, toDate });
      }
    }
  };

  const presets: { id: PresetType; label: string }[] = [
    { id: 'all', label: 'All Time' },
    { id: '7d', label: 'Last 7 Days' },
    { id: '30d', label: 'Last 30 Days' },
    { id: '90d', label: 'Last 90 Days' },
    { id: 'custom', label: 'Custom Range' },
  ];

  return (
    <div className={`flex flex-col gap-4 ${className}`} aria-label="Date Range Picker">
      <div className="flex flex-wrap gap-2" role="group" aria-label="Select Date Range Preset">
        {presets.map((preset) => {
          const isActive = activePreset === preset.id;
          return (
            <button
              key={preset.id}
              type="button"
              onClick={() => setActivePreset(preset.id)}
              aria-pressed={isActive}
              className={`rounded-full px-4 py-1.5 text-xs font-semibold tracking-wide transition-all duration-200 border outline-none
                ${
                  isActive
                    ? 'bg-gradient-to-r from-stellar-purple to-stellar-teal border-transparent text-white shadow-md shadow-stellar-purple/20'
                    : 'bg-white/[0.04] border-white/10 text-white/60 hover:border-white/20 hover:text-white hover:bg-white/[0.08]'
                }`}
            >
              {preset.label}
            </button>
          );
        })}
      </div>

      {activePreset === 'custom' && (
        <div className="flex flex-col sm:flex-row sm:items-center gap-3 animate-fade-in">
          <div className="flex items-center gap-2">
            <label htmlFor="start-date" className="text-xs text-white/50 w-8 font-medium">
              From:
            </label>
            <input
              id="start-date"
              type="date"
              value={customStart}
              onChange={(e) => handleCustomChange(e.target.value, customEnd)}
              className="rounded-lg border border-white/10 bg-white/[0.04] px-3 py-1.5 text-xs text-white outline-none transition-all focus:border-stellar-purple/50 focus:ring-1 focus:ring-stellar-purple/20 font-mono"
            />
          </div>
          <div className="flex items-center gap-2">
            <label htmlFor="end-date" className="text-xs text-white/50 w-8 font-medium">
              To:
            </label>
            <input
              id="end-date"
              type="date"
              value={customEnd}
              onChange={(e) => handleCustomChange(customStart, e.target.value)}
              className="rounded-lg border border-white/10 bg-white/[0.04] px-3 py-1.5 text-xs text-white outline-none transition-all focus:border-stellar-purple/50 focus:ring-1 focus:ring-stellar-purple/20 font-mono"
            />
          </div>

          {validationError && (
            <span role="alert" className="text-xs text-red-400 font-medium animate-pulse">
              ⚠️ {validationError}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
