import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { setAuthTokenGetter } from "@/services/runtimeConfig";
import type { User } from "@/types";
import { secureStorage } from "./secureStorage";

/**
 * The signed-in session: the token from POST /api/auth/login (sent as
 * `Authorization: Bearer …` by the API client) and who it belongs to, kept in
 * the device's secure storage so the farmer stays signed in.
 */
interface AuthState {
  token: string | null;
  user: User | null;
  setSession: (token: string, user: User) => void;
  setUser: (user: User) => void;
  clearSession: () => void;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      token: null,
      user: null,
      setSession: (token, user) => set({ token, user }),
      setUser: (user) => set({ user }),
      clearSession: () => set({ token: null, user: null }),
    }),
    { name: "agrotwin.auth", storage: createJSONStorage(() => secureStorage) }
  )
);

setAuthTokenGetter(() => useAuthStore.getState().token);
