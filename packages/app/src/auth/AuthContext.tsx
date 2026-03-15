import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";
import type { User } from "./types";

interface AuthContextValue {
  user: User | null;
  loading: boolean;
  loginWithGitHub: () => void;
  loginWithGoogle: () => void;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/auth/me")
      .then((res) => {
        if (res.ok) return res.json();
        return null;
      })
      .then((data: User | null) => {
        setUser(data);
      })
      .catch(() => {
        setUser(null);
      })
      .finally(() => {
        setLoading(false);
      });
  }, []);

  const loginWithGitHub = useCallback(() => {
    window.location.href = "/auth/github";
  }, []);

  const loginWithGoogle = useCallback(() => {
    window.location.href = "/auth/google";
  }, []);

  const logout = useCallback(() => {
    fetch("/auth/logout", { method: "POST" }).then((res) => {
      if (res.ok) {
        setUser(null);
      }
    });
  }, []);

  return (
    <AuthContext.Provider
      value={{ user, loading, loginWithGitHub, loginWithGoogle, logout }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return ctx;
}
