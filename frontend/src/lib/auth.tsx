"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  apiLogin,
  apiMe,
  apiSignup,
  clearTokens,
  ensureFreshAccessToken,
  getAccessToken,
  getRefreshToken,
  setTokens,
  type AuthUser,
  type Role,
} from "./api";

const USER_CACHE_KEY = "ta_user";

function readCachedUser(): AuthUser | null {
  if (typeof window === "undefined") return null;
  if (!getAccessToken()) return null;
  try {
    const raw = sessionStorage.getItem(USER_CACHE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as AuthUser;
  } catch {
    return null;
  }
}

function writeCachedUser(user: AuthUser | null) {
  if (typeof window === "undefined") return;
  if (!user) {
    sessionStorage.removeItem(USER_CACHE_KEY);
    return;
  }
  sessionStorage.setItem(USER_CACHE_KEY, JSON.stringify(user));
}

type AuthContextValue = {
  user: AuthUser | null;
  loading: boolean;
  signup: (input: {
    username: string;
    email: string;
    password: string;
    role: Role;
  }) => Promise<void>;
  login: (input: { username: string; password: string }) => Promise<void>;
  logout: () => void;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  // false immediately if we can hydrate from cache — avoids "Loading…" on every route
  const [loading, setLoading] = useState(true);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    const cached = readCachedUser();
    if (cached) {
      setUser(cached);
      setLoading(false);
    }
    setHydrated(true);

    let cancelled = false;
    (async () => {
      if (!getAccessToken() && !getRefreshToken()) {
        writeCachedUser(null);
        if (!cancelled) {
          setUser(null);
          setLoading(false);
        }
        return;
      }
      try {
        await ensureFreshAccessToken();
        const me = await apiMe();
        if (!cancelled) {
          setUser(me);
          writeCachedUser(me);
        }
      } catch {
        clearTokens();
        writeCachedUser(null);
        if (!cancelled) setUser(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const signup = useCallback(
    async (input: {
      username: string;
      email: string;
      password: string;
      role: Role;
    }) => {
      const data = await apiSignup(input);
      setTokens({ access: data.access, refresh: data.refresh });
      setUser(data.user);
      writeCachedUser(data.user);
    },
    []
  );

  const login = useCallback(
    async (input: { username: string; password: string }) => {
      const data = await apiLogin(input);
      setTokens({ access: data.access, refresh: data.refresh });
      setUser(data.user);
      writeCachedUser(data.user);
    },
    []
  );

  const logout = useCallback(() => {
    clearTokens();
    writeCachedUser(null);
    setUser(null);
  }, []);

  useEffect(() => {
    if (!user) return;
    const id = window.setInterval(() => {
      void ensureFreshAccessToken();
    }, 60_000);
    return () => window.clearInterval(id);
  }, [user]);

  const value = useMemo(
    () => ({
      user,
      // Keep loading true only until first hydrate attempt finishes (or cache hit)
      loading: hydrated ? loading : true,
      signup,
      login,
      logout,
    }),
    [user, loading, hydrated, signup, login, logout]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
