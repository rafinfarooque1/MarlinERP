import { createRoot } from 'react-dom/client';
import { setAuthTokenGetter, setAuthTokenSetter, setUnauthorizedHandler } from '@workspace/api-client-react';

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

createRoot(document.getElementById('root')!).render(
  <ThemeProvider>
    <App />
  </ThemeProvider>,
);
