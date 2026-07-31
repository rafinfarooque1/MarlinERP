import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  getMe,
  getGetMeQueryKey,
  listHierarchies,
  getListHierarchiesQueryKey,
  listPermissions,
  getListPermissionsQueryKey,
} from '@workspace/api-client-react';
import type { Employee } from '@workspace/api-client-react';

// The auth response includes this server-authoritative flag, but the generated
// Employee type has not yet caught up with that additive API field.
type AuthenticatedEmployee = Employee & { mustChangePassword?: boolean };

export type SessionStage = 'unauthenticated' | 'restoring' | 'ready' | 'error';

interface SessionContextValue {
  stage: SessionStage;
  error: unknown;
  user: AuthenticatedEmployee | undefined;
  retry: () => void;
  signOut: () => void;
  acceptSession: () => void;
}

const SessionContext = createContext<SessionContextValue | null>(null);

const TOKEN_KEY = 'marlin_auth_token';
const USER_KEY = 'marlin_user';

export function clearStoredSession(queryClient: ReturnType<typeof useQueryClient>) {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
  queryClient.clear();
}

function statusOf(error: unknown): number | undefined {
  return typeof error === 'object' && error !== null && 'status' in error
    ? Number((error as { status?: unknown }).status)
    : undefined;
}

function startupLog(stage: string, details?: Record<string, unknown>) {
  if (import.meta.env.DEV) {
    console.info('[ERP startup]', stage, details ?? {});
  }
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [token, setToken] = useState(() => localStorage.getItem(TOKEN_KEY));

  const me = useQuery({
    queryKey: getGetMeQueryKey(),
    queryFn: () => getMe(),
    enabled: Boolean(token),
    retry: false,
  });
  const startupReadyForMetadata = Boolean(token && me.isSuccess);
  const permissions = useQuery({
    queryKey: getListPermissionsQueryKey(),
    queryFn: () => listPermissions(),
    enabled: startupReadyForMetadata,
    retry: 1,
  });
  const hierarchies = useQuery({
    queryKey: getListHierarchiesQueryKey(),
    queryFn: () => listHierarchies(),
    enabled: startupReadyForMetadata,
    retry: 1,
  });

  const sessionStatus = statusOf(me.error);
  const invalidSession = sessionStatus === 401 || sessionStatus === 403 || sessionStatus === 404;

  useEffect(() => {
    if (!token || !invalidSession) return;
    startupLog('AUTH_INVALID', { status: sessionStatus });
    clearStoredSession(queryClient);
    setToken(null);
  }, [invalidSession, queryClient, sessionStatus, token]);

  useEffect(() => {
    const onUnauthorized = () => {
      if (!localStorage.getItem(TOKEN_KEY)) return;
      startupLog('AUTH_UNAUTHORIZED');
      clearStoredSession(queryClient);
      setToken(null);
    };
    window.addEventListener('marlin:unauthorized', onUnauthorized);
    return () => window.removeEventListener('marlin:unauthorized', onUnauthorized);
  }, [queryClient]);

  const bootstrapError = me.error ?? permissions.error ?? hierarchies.error;
  const isRestoring = Boolean(token) && (
    me.isPending || (me.isSuccess && (permissions.isPending || hierarchies.isPending))
  );
  const stage: SessionStage = !token || invalidSession
    ? 'unauthenticated'
    : isRestoring
      ? 'restoring'
      : bootstrapError
        ? 'error'
        // A protected route may only mount after every bootstrap prerequisite
        // has fulfilled. This defensive branch prevents an unexpected query
        // state from being treated as an authenticated session.
        : me.isSuccess && permissions.isSuccess && hierarchies.isSuccess
          ? 'ready'
          : 'error';

  useEffect(() => {
    startupLog(`AUTH_${stage.toUpperCase()}`, stage === 'error'
      ? { source: me.error ? 'identity' : permissions.error ? 'permissions' : 'hierarchies' }
      : undefined);
  }, [me.error, permissions.error, stage]);

  const value = useMemo<SessionContextValue>(() => ({
    stage,
    error: stage === 'error' ? bootstrapError : undefined,
    user: me.data as AuthenticatedEmployee | undefined,
    retry: () => {
      startupLog('AUTH_RETRY');
      void me.refetch();
      void permissions.refetch();
      void hierarchies.refetch();
    },
    signOut: () => {
      clearStoredSession(queryClient);
      setToken(null);
    },
    acceptSession: () => {
      startupLog('AUTH_LOGIN_ACCEPTED');
      setToken(localStorage.getItem(TOKEN_KEY));
    },
  }), [bootstrapError, hierarchies, me, permissions, queryClient, stage]);

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession() {
  const context = useContext(SessionContext);
  if (!context) throw new Error('useSession must be used within SessionProvider');
  return context;
}