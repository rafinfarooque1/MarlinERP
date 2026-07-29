import { useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { customFetch } from '@workspace/api-client-react';

/**
 * Company feature flags, read from `company_settings.generalSettings`.
 *
 * Outlet Management is the first flag. Outlets were folded into warehouses, so
 * the module ships retired: OFF by default, with every outlet record kept
 * read-only for historical reports, audits and past transactions. The backend
 * refuses outlet writes independently — this hook only decides what the UI
 * offers, and must never be treated as the enforcement point.
 */
export interface FeatureFlags {
  outletsEnabled: boolean;
}

const FLAG_DEFAULTS: FeatureFlags = {
  outletsEnabled: false,
};

export function useFeatureFlags() {
  const query = useQuery({
    queryKey: ['company', 'feature-flags'],
    queryFn: async (): Promise<FeatureFlags> => {
      const s = await customFetch<any>('/api/company/settings');
      const gs = (s?.generalSettings ?? {}) as Record<string, unknown>;
      const bool = (k: keyof FeatureFlags) => {
        const v = gs[k];
        if (typeof v === 'boolean') return v;
        if (typeof v === 'string') return v === 'true';
        return FLAG_DEFAULTS[k];
      };
      return { outletsEnabled: bool('outletsEnabled') };
    },
    staleTime: 60_000,
  });

  // Default to the safe (retired) state while loading or on error, so a failed
  // settings fetch can never accidentally re-open outlet operations.
  return {
    flags: query.data ?? FLAG_DEFAULTS,
    isLoading: query.isLoading,
  };
}

/** Convenience: is the retired Outlet module currently active? */
export function useOutletsEnabled(): { outletsEnabled: boolean; isLoading: boolean } {
  const { flags, isLoading } = useFeatureFlags();
  return { outletsEnabled: flags.outletsEnabled, isLoading };
}

/**
 * Clears a location filter that is still pointing at an outlet once Outlet
 * Management has been switched off.
 *
 * Hiding the option is not enough on its own. A filter still *holding* an outlet
 * value keeps scoping the page to that outlet just as the control to clear it
 * disappears — every total on screen would quietly understate, with nothing left
 * in the UI to explain or undo it. Hiding must remove the affordance, never the
 * data.
 *
 * The reset runs in an effect rather than during render, so it stays a state
 * update instead of a side effect in the render path.
 *
 * @param isOutletSelected whether the current value refers to an outlet
 * @param clear            resets the filter to its neutral, non-outlet value
 */
export function useClearOutletSelection(isOutletSelected: boolean, clear: () => void): void {
  const { outletsEnabled } = useOutletsEnabled();
  // Latest-callback ref: callers pass an inline arrow, so depending on `clear`
  // directly would re-run the effect on every render.
  const clearRef = useRef(clear);
  clearRef.current = clear;
  useEffect(() => {
    if (!outletsEnabled && isOutletSelected) clearRef.current();
  }, [outletsEnabled, isOutletSelected]);
}

export const OUTLETS_LEGACY_NOTE =
  'Outlet Management is turned off. These records are kept for historical reports and audits — ' +
  'they can be viewed but not changed. Turn Outlet Management on in Settings to use outlets again.';
