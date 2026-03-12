import { useCallback, useEffect, useState, useSyncExternalStore } from "react";

export type ColorSchemePreference = "light" | "dark" | "system";

const STORAGE_KEY = "anipres-color-scheme";

const darkMql = window.matchMedia("(prefers-color-scheme: dark)");

function subscribeOsScheme(callback: () => void) {
  darkMql.addEventListener("change", callback);
  return () => darkMql.removeEventListener("change", callback);
}

function getOsSchemeSnapshot(): "light" | "dark" {
  return darkMql.matches ? "dark" : "light";
}

export function useColorScheme() {
  const [preference, setPreference] = useState<ColorSchemePreference>(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "light" || stored === "dark" || stored === "system")
      return stored;
    return "system";
  });

  const osScheme = useSyncExternalStore(subscribeOsScheme, getOsSchemeSnapshot);
  const resolved: "light" | "dark" =
    preference === "system" ? osScheme : preference;

  const changePreference = useCallback((next: ColorSchemePreference) => {
    setPreference(next);
    localStorage.setItem(STORAGE_KEY, next);
  }, []);

  // Apply data-color-scheme to <html> for CSS
  useEffect(() => {
    document.documentElement.dataset.colorScheme = resolved;
  }, [resolved]);

  return { preference, resolved, changePreference } as const;
}
