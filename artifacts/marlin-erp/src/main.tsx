import { createRoot } from 'react-dom/client';
import { setAuthTokenGetter, setAuthTokenSetter } from '@workspace/api-client-react';

import App from './App';
import { ThemeProvider } from './lib/theme';
import './index.css';

// Wire up bearer token from localStorage for every API call
setAuthTokenGetter(() => localStorage.getItem('marlin_auth_token'));
// Persist upgraded session tokens the server sends via x-refreshed-token
setAuthTokenSetter((token) => localStorage.setItem('marlin_auth_token', token));

createRoot(document.getElementById('root')!).render(
  <ThemeProvider>
    <App />
  </ThemeProvider>,
);
