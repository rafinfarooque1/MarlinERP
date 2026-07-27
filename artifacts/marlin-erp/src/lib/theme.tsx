import { createContext, useContext, useEffect, useState } from 'react';

type Theme = 'dark' | 'light';

interface ThemeContextType {
  theme: Theme;
  toggleTheme: () => void;
  setTheme: (theme: Theme) => void;
}

const ThemeContext = createContext<ThemeContextType>({
  theme: 'light',
  toggleTheme: () => {},
  setTheme: () => {},
});

/**
 * Theme policy (owner preference): the app always OPENS in light mode — a fresh
 * tab/window starts light regardless of what was used last visit. The header
 * toggle still works, and the choice survives reloads within the same browser
 * session (sessionStorage), but never carries over to the next visit.
 * Logging in also resets to light (see the login page).
 */
export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setTheme] = useState<Theme>(() => {
    try {
      localStorage.removeItem('marlin_theme'); // legacy persistent key, no longer honored
      return sessionStorage.getItem('marlin_theme') === 'dark' ? 'dark' : 'light';
    } catch {
      return 'light'; // storage unavailable (e.g. old private-mode Safari)
    }
  });

  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'dark') {
      root.classList.add('dark');
    } else {
      root.classList.remove('dark');
    }
    try {
      sessionStorage.setItem('marlin_theme', theme);
    } catch {
      // storage unavailable — theme simply won't survive a reload
    }
  }, [theme]);

  const toggleTheme = () => setTheme(t => (t === 'dark' ? 'light' : 'dark'));

  return (
    <ThemeContext.Provider value={{ theme, toggleTheme, setTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export const useTheme = () => useContext(ThemeContext);
