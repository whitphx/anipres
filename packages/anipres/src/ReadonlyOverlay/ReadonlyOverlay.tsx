import { useRef } from "react";
import { Atom, useValue, usePassThroughWheelEvents } from "tldraw";
import styles from "./ReadonlyOverlay.module.scss";

// To prevent the user from interacting with the canvas while in presentation mode,
// except for scrolling.
interface ReadonlyOverlayProps {
  children?: React.ReactNode;
  $presentationMode: Atom<boolean>;
}
export function ReadonlyOverlay(props: ReadonlyOverlayProps) {
  const ref = useRef<HTMLDivElement>(null);
  usePassThroughWheelEvents(ref);
  const presentationMode = useValue(props.$presentationMode);
  return (
    presentationMode && (
      <div ref={ref} className={styles.readonlyOverlay}>
        {props.children}
      </div>
    )
  );
}
