import { createContext, useContext, useState, ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';

export interface LocationState {
  locationType: 'warehouse' | 'outlet' | 'all' | null;
  locationId: number | null;
  locationName: string;
}

/** Canonical "no location filter" state used by the global selector. */
export const ALL_LOCATIONS: LocationState = {
  locationType: 'all',
  locationId: null,
  locationName: 'All Locations',
};

/**
 * The query params a page should send for the current location context.
 * `null`/`'all'` both mean "no location filter" — the backend then falls back
 * to the caller's own LBAC scope, which is the widest they may ever see.
 */
export function locationFilterParams(s: LocationState): { locationType?: 'warehouse' | 'outlet'; locationId?: number } {
  if ((s.locationType === 'warehouse' || s.locationType === 'outlet') && s.locationId) {
    return { locationType: s.locationType, locationId: s.locationId };
  }
  return {};
}

const STORAGE_KEY = 'marlin_sales_location';

function loadFromStorage(): LocationState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* ignore */ }
  return { locationType: null, locationId: null, locationName: '' };
}

interface LocationContextType {
  locationState: LocationState;
  setLocation: (state: LocationState) => void;
  clearLocation: () => void;
}

const LocationContext = createContext<LocationContextType | null>(null);

export function LocationProvider({ children }: { children: ReactNode }) {
  const [locationState, setLocationState] = useState<LocationState>(loadFromStorage);
  const queryClient = useQueryClient();

  const setLocation = (state: LocationState) => {
    const changed =
      state.locationType !== locationState.locationType ||
      state.locationId !== locationState.locationId;
    setLocationState(state);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    // The location headers ride OUTSIDE query keys, so every cached answer is
    // for the previous location — refetch the whole ERP view.
    if (changed) queryClient.invalidateQueries();
  };

  const clearLocation = () => {
    const empty: LocationState = { locationType: null, locationId: null, locationName: '' };
    const changed = locationState.locationType !== null || locationState.locationId !== null;
    setLocationState(empty);
    localStorage.removeItem(STORAGE_KEY);
    if (changed) queryClient.invalidateQueries();
  };

  return (
    <LocationContext.Provider value={{ locationState, setLocation, clearLocation }}>
      {children}
    </LocationContext.Provider>
  );
}

export function useLocationContext() {
  const ctx = useContext(LocationContext);
  if (!ctx) throw new Error('useLocationContext must be used within LocationProvider');
  return ctx;
}
