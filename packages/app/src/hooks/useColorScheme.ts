import { useCallback, useEffect, useState, useSyncExternalStore } from "react";

export type ColorSchemePreference = "light" | "dark" | "system";

const STORAGE_KEY = "anipres-color-scheme";

let darkMql: MediaQueryList | null = null;
function getDarkMql(): MediaQueryList {
  if (!darkMql) {
    darkMql = window.matchMedia("(prefers-color-scheme: dark)");
  }
  return darkMql;
}

function subscribeOsScheme(callback: () => void) {
  const mql = getDarkMql();
  mql.addEventListener("change", callback);
  return () => mql.removeEventListener("change", callback);
}

function getOsSchemeSnapshot(): "light" | "dark" {
  return getDarkMql().matches ? "dark" : "light";
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
