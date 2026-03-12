import { Monitor, Moon, Sun } from "lucide-react";
import type { ReactNode } from "react";
import type { ColorSchemePreference } from "../hooks/useColorScheme";
import styles from "./ColorSchemeSwitcher.module.css";

interface ColorSchemeSwitcherProps {
  preference: ColorSchemePreference;
  onChange: (next: ColorSchemePreference) => void;
}

const options: { value: ColorSchemePreference; label: ReactNode }[] = [
  { value: "light", label: <Sun size={14} /> },
  { value: "system", label: <Monitor size={14} /> },
  { value: "dark", label: <Moon size={14} /> },
];

export function ColorSchemeSwitcher({
  preference,
  onChange,
}: ColorSchemeSwitcherProps) {
  return (
    <div className={styles.switcher}>
      <div className={styles.track}>
        {options.map((opt) => {
          const label = opt.value.charAt(0).toUpperCase() + opt.value.slice(1);
          return (
            <button
              key={opt.value}
              type="button"
              className={`${styles.option} ${preference === opt.value ? styles.active : ""}`}
              onClick={() => onChange(opt.value)}
              title={label}
              aria-label={label}
              aria-pressed={preference === opt.value}
            >
              {opt.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
