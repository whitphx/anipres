import type { ColorSchemePreference } from "../hooks/useColorScheme";
import styles from "./ColorSchemeSwitcher.module.css";

interface ColorSchemeSwitcherProps {
  preference: ColorSchemePreference;
  onChange: (next: ColorSchemePreference) => void;
}

const options: { value: ColorSchemePreference; label: string }[] = [
  { value: "light", label: "\u2600" },
  { value: "system", label: "\uD83D\uDCBB" },
  { value: "dark", label: "\uD83C\uDF19" },
];

export function ColorSchemeSwitcher({
  preference,
  onChange,
}: ColorSchemeSwitcherProps) {
  return (
    <div className={styles.switcher}>
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
  );
}
