import { createContext, useContext, useState, ReactNode } from 'react';

export interface LocationState {
  locationType: 'warehouse' | 'outlet' | 'all' | null;
  locationId: number | null;
  locationName: string;
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

  const setLocation = (state: LocationState) => {
    setLocationState(state);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  };

  const clearLocation = () => {
    const empty: LocationState = { locationType: null, locationId: null, locationName: '' };
    setLocationState(empty);
    localStorage.removeItem(STORAGE_KEY);
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
