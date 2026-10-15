import { createContext, useCallback, useContext, useEffect, useMemo, useState, type PropsWithChildren } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useAuthStore } from "@/stores/authStore";
import { authService } from "@/services/auth";
import { setConsentRequiredHandler, setUnauthorizedHandler } from "@/services/runtimeConfig";
import type { User } from "@/types";

/**
 * Who is signed in. `ready` turns true once the saved session has been read
 * from secure storage — until then nobody is redirected to the sign-in screen.
 * A 401 from the server (session expired, account switched off) signs out.
 */
interface AuthContextValue {
  ready: boolean;
  isAuthenticated: boolean;
  user: User | null;
  /** First name for greetings. */
  userName: string | null;
  /** Admin or operator: rebuilding maps, re-checking crop health and importing
   * processed files are staff tools (the server refuses them for farmers). */
  isStaff: boolean;
  /** A farmer who must accept the data agreement (or its new version) first. */
  needsAgreement: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  acceptAgreement: (version: string) => Promise<void>;
  /** Deletes the account and all its data, then signs out. */
  deleteAccount: (password: string, confirm: string) => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: PropsWithChildren) {
  const queryClient = useQueryClient();
  const token = useAuthStore((s) => s.token);
  const user = useAuthStore((s) => s.user);
  const setSession = useAuthStore((s) => s.setSession);
  const setUser = useAuthStore((s) => s.setUser);
  const clearSession = useAuthStore((s) => s.clearSession);
  const [ready, setReady] = useState(() => useAuthStore.persist.hasHydrated());

  useEffect(() => {
    if (ready) return undefined;
    return useAuthStore.persist.onFinishHydration(() => setReady(true));
  }, [ready]);

  // nothing cached for one farmer may show for the next on a shared phone
  const endSession = useCallback(() => {
    clearSession();
    queryClient.clear();
  }, [clearSession, queryClient]);

  useEffect(() => {
    setUnauthorizedHandler(endSession);
    return () => setUnauthorizedHandler(() => {});
  }, [endSession]);

  // the server asks for the data agreement: the fresh account says so, and the gate shows it
  useEffect(() => {
    setConsentRequiredHandler(() => {
      authService.me().then(setUser).catch(() => undefined);
    });
    return () => setConsentRequiredHandler(() => {});
  }, [setUser]);

  // refresh name / role once per start (an admin may have changed them)
  useEffect(() => {
    if (!ready || !token) return;
    authService.me().then(setUser).catch(() => undefined);
  }, [ready, token, setUser]);

  const signIn = useCallback(
    async (email: string, password: string) => {
      const { token: newToken, user: signedIn } = await authService.login(email, password);
      queryClient.clear();
      setSession(newToken, signedIn);
    },
    [queryClient, setSession]
  );

  const signOut = useCallback(async () => {
    await authService.logout().catch(() => undefined);
    endSession();
  }, [endSession]);

  const acceptAgreement = useCallback(
    async (version: string) => {
      setUser(await authService.acceptAgreement(version));
      queryClient.invalidateQueries();
    },
    [queryClient, setUser]
  );

  const deleteAccount = useCallback(
    async (password: string, confirm: string) => {
      await authService.deleteAccount(password, confirm);
      endSession();
    },
    [endSession]
  );

  const value = useMemo<AuthContextValue>(
    () => ({
      ready,
      isAuthenticated: !!token,
      user,
      userName: user?.name?.split(" ")[0] ?? null,
      isStaff: user?.role === "admin" || user?.role === "operator",
      needsAgreement: !!token && !!user?.consent_required,
      signIn,
      signOut,
      acceptAgreement,
      deleteAccount,
    }),
    [ready, token, user, signIn, signOut, acceptAgreement, deleteAccount]
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}
