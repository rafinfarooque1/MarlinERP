import { createRoot } from 'react-dom/client';
import { setAuthTokenGetter } from '@workspace/api-client-react';

import App from './App';
import { ThemeProvider } from './lib/theme';
import './index.css';

// Wire up bearer token from localStorage for every API call
setAuthTokenGetter(() => localStorage.getItem('marlin_auth_token'));

createRoot(document.getElementById('root')!).render(
  <ThemeProvider>
    <App />
  </ThemeProvider>,
);
