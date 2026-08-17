import React, { createContext, useContext, useEffect, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useQueryClient } from '@tanstack/react-query';
import {
  customFetch,
  setAuthTokenGetter,
  setAuthTokenSetter,
  setUnauthorizedHandler,
} from '@workspace/api-client-react';
import { clearLocationSnapshot } from '@/lib/locationSnapshot';

export interface AuthEmployee {
  id: number;
  name: string;
  username: string;
  email: string | null;
  phone: string | null;
  hierarchyId: number;
  hierarchyName: string;
  branchType: string;
  branchId: number;
  branchName: string;
  salary: number;
  joinDate: string;
  photoUrl: string | null;
  isActive: boolean;
  mustChangePassword?: boolean;
  /** Server-persisted UI location preference (JSON string) — display only. */
  uiLocationPref?: string | null;
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
  const queryClient = useQueryClient();
  const [token, setToken] = useState<string | null>(null);
  const [employee, setEmployee] = useState<AuthEmployee | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  // Every session boundary (login, logout, confirmed 401) must wipe BOTH the
  // query cache and the location header snapshot SYNCHRONOUSLY. Query keys
  // are global (not per-user) and location headers ride outside query keys —
  // without this, the next account on the same device could render the
  // previous user's cached payroll/permission data or fire its first
  // requests with the previous user's warehouse headers.
  const resetSessionState = () => {
    clearLocationSnapshot();
    queryClient.cancelQueries().catch(() => {});
    queryClient.clear();
  };

  useEffect(() => {
    // A confirmed 401 means the persisted token expired (8-hour server
    // expiry) or was revoked. Without this handler the app keeps the dead
    // session forever — every screen silently fails until the user guesses
    // to log out. Clear the session so the root layout routes to /login.
    setUnauthorizedHandler(() => {
      AsyncStorage.multiRemove([TOKEN_KEY, EMPLOYEE_KEY]).catch(() => {});
      setAuthTokenGetter(null);
      setAuthTokenSetter(null);
      resetSessionState();
      setToken(null);
      setEmployee(null);
    });
    return () => setUnauthorizedHandler(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    async function loadPersistedAuth() {
      try {
        const [savedToken, savedEmployee] = await Promise.all([
          AsyncStorage.getItem(TOKEN_KEY),
          AsyncStorage.getItem(EMPLOYEE_KEY),
        ]);
        if (!savedToken) return;

        // Wire up the token getter so all API calls are authenticated
        const t = savedToken;
        setAuthTokenGetter(() => t);
        setAuthTokenSetter((newToken: string) => {
          setToken(newToken);
          AsyncStorage.setItem(TOKEN_KEY, newToken).catch(() => {});
        });

        let stored: AuthEmployee | null = null;
        if (savedEmployee) {
          try { stored = JSON.parse(savedEmployee); } catch { stored = null; }
        }
        // Records persisted by the pre-ERP app lack hierarchyId/branchId —
        // permission resolution would deny everything and branch pinning
        // would send an undefined location. Only the current shape may be
        // used without a server refresh.
        const storedUsable =
          !!stored &&
          typeof stored.hierarchyId === 'number' &&
          typeof stored.branchId === 'number' &&
          typeof stored.branchType === 'string';

        // Refresh the employee from the server so stale/legacy persisted
        // records never drive permissions or location pinning.
        try {
          const fresh = await customFetch<AuthEmployee>('/api/auth/me');
          const emp: AuthEmployee = {
            ...fresh,
            mustChangePassword:
              fresh.mustChangePassword ?? stored?.mustChangePassword ?? false,
          };
          AsyncStorage.setItem(EMPLOYEE_KEY, JSON.stringify(emp)).catch(() => {});
          setToken(savedToken);
          setEmployee(emp);
        } catch (err) {
          const isHttpError = err instanceof Error && err.name === 'ApiError';
          if (isHttpError) {
            // Rejected by the server (expired token → the 401 handler has
            // already cleared storage; deactivated → 403). Fail closed.
            await AsyncStorage.multiRemove([TOKEN_KEY, EMPLOYEE_KEY]).catch(() => {});
            setAuthTokenGetter(null);
            setAuthTokenSetter(null);
            return;
          }
          // Network failure (offline start). A current-shape stored record
          // is safe to keep — the server still re-checks everything. A
          // legacy record is not: fail closed to the login screen.
          if (storedUsable && stored) {
            setToken(savedToken);
            setEmployee(stored);
          } else {
            setAuthTokenGetter(null);
            setAuthTokenSetter(null);
          }
        }
      } catch {
        // Ignore storage errors — user will see login screen
      } finally {
        setIsLoading(false);
      }
    }
    loadPersistedAuth();
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

    // New session: drop anything cached or scoped under the previous account
    // BEFORE the new token/employee state lands and screens start querying.
    resetSessionState();

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
    resetSessionState();
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
