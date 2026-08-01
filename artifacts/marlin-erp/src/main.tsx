import { createRoot } from 'react-dom/client';
import { setAuthTokenGetter, setAuthTokenSetter, setUnauthorizedHandler, setLocationContextGetter } from '@workspace/api-client-react';

import App from './App';
import { ThemeProvider } from './lib/theme';
import './index.css';

// Wire up bearer token from localStorage for every API call
setAuthTokenGetter(() => localStorage.getItem('marlin_auth_token'));
// Persist upgraded session tokens the server sends via x-refreshed-token
setAuthTokenSetter((token) => localStorage.setItem('marlin_auth_token', token));
// A token can expire after startup. Signal the session owner instead of leaving
// whichever page made the request in an error/skeleton state. The owner clears
// only session-scoped cache and routes through the normal unauthenticated guard.
setUnauthorizedHandler(() => window.dispatchEvent(new Event('marlin:unauthorized')));
// Global location context — every API call carries the selected location as
// x-location-type / x-location-id headers. 'All Locations' (or nothing picked)
// sends no headers; the server treats them as a view filter, never authority.
setLocationContextGetter(() => {
  try {
    const raw = localStorage.getItem('marlin_sales_location');
    if (!raw) return null;
    const s = JSON.parse(raw) as { locationType?: string | null; locationId?: number | null };
    if ((s.locationType === 'warehouse' || s.locationType === 'outlet') && s.locationId) {
      return { locationType: s.locationType, locationId: Number(s.locationId) };
    }
    return null;
  } catch {
    return null;
  }
});

createRoot(document.getElementById('root')!).render(
  <ThemeProvider>
    <App />
  </ThemeProvider>,
);
