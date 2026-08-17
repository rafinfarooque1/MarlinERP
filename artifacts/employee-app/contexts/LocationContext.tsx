import React, { createContext, useContext, useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { customFetch, setLocationContextGetter } from '@workspace/api-client-react';
import { useAuth } from '@/contexts/AuthContext';
import {
  clearLocationSnapshot,
  getLocationSnapshot,
  headerSignature,
  setLocationSnapshot,
} from '@/lib/locationSnapshot';

/**
 * Global location context — the mobile mirror of the web sidebar's
 * "Current Location" selector (marlin-erp/src/lib/locationContext.tsx).
 *
 * Warehouse/outlet employees are PINNED to their login branch: they see a
 * fixed label, never a selector. Head Office users may narrow their view to
 * one location or see everything ("All Locations").
 *
 * The selection rides on every API request as x-location-type/x-location-id
 * headers via the shared api client — the server treats those as a VIEW
 * filter layered on top of its own access control. They can only narrow what
 * the caller may already see; write paths ignore them entirely. Matching the
 * web client, only warehouse/outlet selections send headers — "Head Office"
 * and "All Locations" send none (HO pages pass explicit query params where
 * supported).
 *
 * A Head Office user's selection is a PER-USER preference persisted on the
 * server (employees.ui_location_pref via PUT /auth/location-pref), exactly
 * like the web sidebar. Never a device-global store: two HO users sharing a
 * phone must never inherit each other's selected warehouse.
 */

export interface LocationState {
  locationType: 'warehouse' | 'outlet' | 'headoffice' | 'all';
  locationId: number | null;
  locationName: string;
}

export const ALL_LOCATIONS: LocationState = {
  locationType: 'all',
  locationId: null,
  locationName: 'All Locations',
};

interface LocationContextType {
  location: LocationState;
  /** True when the user's branch decides the location (no selector shown). */
  locked: boolean;
  setLocation: (state: LocationState) => void;
}

const LocationContext = createContext<LocationContextType>({
  location: ALL_LOCATIONS,
  locked: false,
  setLocation: () => {},
});

/** Parse the server-persisted preference JSON (employee.uiLocationPref). */
function parseServerPref(raw: unknown): LocationState | null {
  if (!raw || typeof raw !== 'string') return null;
  try {
    const p = JSON.parse(raw);
    if (!p || typeof p !== 'object') return null;
    if (p.locationType === 'all') return ALL_LOCATIONS;
    if (p.locationType === 'headoffice') {
      return { locationType: 'headoffice', locationId: 1, locationName: 'Head Office' };
    }
    if ((p.locationType === 'warehouse' || p.locationType === 'outlet') && Number(p.locationId) > 0) {
      return {
        locationType: p.locationType,
        locationId: Number(p.locationId),
        locationName: typeof p.locationName === 'string' ? p.locationName : '',
      };
    }
  } catch {
    /* a malformed pref is ignored, never fatal */
  }
  return null;
}

/** Fire-and-forget server persistence of an HO selection (display pref only). */
function persistPref(state: LocationState): void {
  const body =
    state.locationType === 'warehouse' || state.locationType === 'outlet'
      ? { locationType: state.locationType, locationId: state.locationId, locationName: state.locationName }
      : { locationType: state.locationType };
  customFetch('/api/auth/location-pref', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).catch(() => { /* a lost pref is cosmetic — never block the UI on it */ });
}

export function LocationProvider({ children }: { children: React.ReactNode }) {
  const { employee } = useAuth();
  const queryClient = useQueryClient();
  const [location, setLocationState] = useState<LocationState>(ALL_LOCATIONS);

  const locked =
    !!employee && employee.branchType !== 'headoffice';

  // Register the header getter once for the app's lifetime.
  useEffect(() => {
    setLocationContextGetter(() => {
      const s = getLocationSnapshot();
      if (
        s &&
        (s.locationType === 'warehouse' || s.locationType === 'outlet') &&
        s.locationId
      ) {
        return { locationType: s.locationType, locationId: s.locationId };
      }
      return null;
    });
    return () => setLocationContextGetter(null);
  }, []);

  // Pin or restore the selection whenever the signed-in employee changes.
  // AuthContext already clears the snapshot AND the query cache synchronously
  // on login/logout/401, so requests fired before this effect runs carry no
  // stale headers. If applying the new location changes the effective header
  // signature after queries may have fired, invalidate so nothing rendered
  // was fetched under the wrong scope.
  useEffect(() => {
    const apply = (next: LocationState) => {
      const sigChanged = headerSignature(getLocationSnapshot()) !== headerSignature(next);
      setLocationSnapshot(next);
      setLocationState(next);
      if (sigChanged) queryClient.invalidateQueries();
    };

    if (!employee) {
      clearLocationSnapshot();
      setLocationState(ALL_LOCATIONS);
      return;
    }

    if (employee.branchType === 'warehouse' || employee.branchType === 'outlet') {
      // Branch logins are location-locked — force-sync to their branch so a
      // stale persisted selection can never misstate the working location.
      apply({
        locationType: employee.branchType,
        locationId: employee.branchId,
        locationName: employee.branchName,
      });
      return;
    }

    // Head Office user — restore THEIR server-persisted preference (rides on
    // the employee record, so it follows the user across devices and can
    // never leak between two accounts sharing one phone).
    apply(parseServerPref(employee.uiLocationPref) ?? ALL_LOCATIONS);
  }, [employee?.id, employee?.branchType, employee?.branchId, employee?.branchName]); // eslint-disable-line react-hooks/exhaustive-deps

  const setLocation = (state: LocationState) => {
    if (locked) return; // branch users can never change their location
    const changed =
      state.locationType !== location.locationType ||
      state.locationId !== location.locationId;
    setLocationSnapshot(state);
    setLocationState(state);
    persistPref(state); // per-user server preference, same as the web sidebar
    // Location headers ride OUTSIDE query keys, so every cached answer is for
    // the previous location — refetch the whole view (same as the web app).
    if (changed) queryClient.invalidateQueries();
  };

  return (
    <LocationContext.Provider value={{ location, locked, setLocation }}>
      {children}
    </LocationContext.Provider>
  );
}

export function useLocationContext() {
  return useContext(LocationContext);
}
