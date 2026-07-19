import { useState, useCallback } from 'react';

const UNITS_KEY = 'marlin_units';

const DEFAULT_UNITS = [
  'kg', 'g', 'tonne', 'quintal',
  'litre', 'ml',
  'pkt', 'pcs', 'dozen',
  'boxes', 'cartons', 'rolls',
  'crate', 'bag', 'sack',
];

function loadUnits(): string[] {
  try {
    const raw = localStorage.getItem(UNITS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    }
  } catch {}
  // Seed defaults on first load
  localStorage.setItem(UNITS_KEY, JSON.stringify(DEFAULT_UNITS));
  return DEFAULT_UNITS;
}

export function useUnits() {
  const [units, setUnitsState] = useState<string[]>(loadUnits);

  const persist = (next: string[]) => {
    localStorage.setItem(UNITS_KEY, JSON.stringify(next));
    setUnitsState(next);
    window.dispatchEvent(new CustomEvent('marlin_units_changed', { detail: next }));
  };

  const addUnit = useCallback((unit: string) => {
    const clean = unit.trim().toLowerCase();
    if (!clean) return false;
    const current = loadUnits();
    if (current.includes(clean)) return false;
    persist([...current, clean]);
    return true;
  }, []);

  const removeUnit = useCallback((unit: string) => {
    const current = loadUnits();
    persist(current.filter(u => u !== unit));
  }, []);

  return { units, addUnit, removeUnit };
}
