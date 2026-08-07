import React, { createContext, useContext, useEffect, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  customFetch,
  setAuthTokenGetter,
  setAuthTokenSetter,
  setUnauthorizedHandler,
} from '@workspace/api-client-react';

export interface AuthEmployee {
  id: number;
  name: string;
  username: string;
  email: string | null;
  phone: string | null;
  hierarchyName: string;
  branchType: string;
  branchName: string;
  salary: number;
  joinDate: string;
  photoUrl: string | null;
  isActive: boolean;
  mustChangePassword?: boolean;
}

interface AuthContextType {
  token: string | null;
  employee: AuthEmployee | null;
  isLoading: boolean;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  /** Clears the mustChangePassword flag after an in-app password change. */
  markPasswordChanged: () => void;
}

const AuthContext = createContext<AuthContextType>({
  token: null,
  employee: null,
  isLoading: true,
  login: async () => {},
  logout: async () => {},
  markPasswordChanged: () => {},
});

const TOKEN_KEY = '@marlin_auth_token';
const EMPLOYEE_KEY = '@marlin_auth_employee';

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [token, setToken] = useState<string | null>(null);
  const [employee, setEmployee] = useState<AuthEmployee | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    // A confirmed 401 means the persisted token expired (8-hour server
    // expiry) or was revoked. Without this handler the app keeps the dead
    // session forever — every screen silently fails until the user guesses
    // to log out. Clear the session so the root layout routes to /login.
    setUnauthorizedHandler(() => {
      AsyncStorage.multiRemove([TOKEN_KEY, EMPLOYEE_KEY]).catch(() => {});
      setAuthTokenGetter(null);
      setAuthTokenSetter(null);
      setToken(null);
      setEmployee(null);
    });
    return () => setUnauthorizedHandler(null);
  }, []);

  useEffect(() => {
    async function loadPersistedAuth() {
      try {
        const [savedToken, savedEmployee] = await Promise.all([
          AsyncStorage.getItem(TOKEN_KEY),
          AsyncStorage.getItem(EMPLOYEE_KEY),
        ]);
        if (savedToken) {
          setToken(savedToken);
          // Wire up the token getter so all API calls are authenticated
          const t = savedToken;
          setAuthTokenGetter(() => t);
          setAuthTokenSetter((newToken: string) => {
            setToken(newToken);
            AsyncStorage.setItem(TOKEN_KEY, newToken).catch(() => {});
          });
        }
        if (savedEmployee) {
          setEmployee(JSON.parse(savedEmployee));
        }
      } catch {
        // Ignore storage errors — user will see login screen
      } finally {
        setIsLoading(false);
      }
    }
    loadPersistedAuth();
  }, []);

  const login = async (username: string, password: string): Promise<void> => {
    const resp = await customFetch<{ token: string; employee: AuthEmployee; mustChangePassword?: boolean }>(
      '/api/auth/login',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      },
    );

    const emp: AuthEmployee = {
      ...resp.employee,
      mustChangePassword: resp.mustChangePassword ?? (resp.employee as any).mustChangePassword ?? false,
    };

    await Promise.all([
      AsyncStorage.setItem(TOKEN_KEY, resp.token),
      AsyncStorage.setItem(EMPLOYEE_KEY, JSON.stringify(emp)),
    ]);

    const t = resp.token;
    setAuthTokenGetter(() => t);
    setAuthTokenSetter((newToken: string) => {
      setToken(newToken);
      AsyncStorage.setItem(TOKEN_KEY, newToken).catch(() => {});
    });
    setToken(resp.token);
    setEmployee(emp);
  };

  const logout = async (): Promise<void> => {
    await Promise.all([
      AsyncStorage.removeItem(TOKEN_KEY),
      AsyncStorage.removeItem(EMPLOYEE_KEY),
    ]);
    setAuthTokenGetter(null);
    setAuthTokenSetter(null);
    setToken(null);
    setEmployee(null);
  };

  const markPasswordChanged = (): void => {
    setEmployee((prev) => {
      if (!prev) return prev;
      const updated = { ...prev, mustChangePassword: false };
      AsyncStorage.setItem(EMPLOYEE_KEY, JSON.stringify(updated)).catch(() => {});
      return updated;
    });
  };

  return (
    <AuthContext.Provider value={{ token, employee, isLoading, login, logout, markPasswordChanged }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
