import {
  EASINGS,
  TldrawUiPopover,
  TldrawUiPopoverTrigger,
  TldrawUiPopoverContent,
} from "tldraw";
import type { FrameUIData } from "../frame-ui-data";
import { NumberField } from "./NumberField";
import { SelectField } from "./SelectField";
import styles from "./FrameEditPopover.module.scss";

const EASINGS_OPTIONS = Object.keys(EASINGS);
function isEasingOption(value: string): value is keyof typeof EASINGS {
  return EASINGS_OPTIONS.includes(value);
}

export interface FrameEditPopoverProps {
  frame: FrameUIData;
  onUpdate: (newFrame: FrameUIData) => void;
  children: React.ReactNode;
}
export function FrameEditPopover({
  frame,
  onUpdate,
  children,
}: FrameEditPopoverProps) {
  return (
    <TldrawUiPopover id={`frame-config-${frame.shapeId}`}>
      <TldrawUiPopoverTrigger>{children}</TldrawUiPopoverTrigger>
      <TldrawUiPopoverContent side="bottom" sideOffset={6}>
        <div className={styles.popoverContent}>
          {frame.action.type === "cameraZoom" && (
            <NumberField
              label="Inset"
              value={frame.action.inset ?? 0}
              onChange={(newInset) =>
                onUpdate({
                  ...frame,
                  action: {
                    ...frame.action,
                    inset: newInset,
                  },
                })
              }
            />
          )}
          <NumberField
            label="Duration"
            value={frame.action.duration ?? 0}
            onChange={(newDuration) =>
              onUpdate({
                ...frame,
                action: {
                  ...frame.action,
                  duration: newDuration,
                },
              })
            }
          />
          <SelectField
            label="Easing"
            value={frame.action.easing ?? ""}
            options={EASINGS_OPTIONS}
            onChange={(newEasing) => {
              if (isEasingOption(newEasing)) {
                onUpdate({
                  ...frame,
                  action: {
                    ...frame.action,
                    easing: newEasing,
                  },
                });
              }
            }}
          />
        </div>
      </TldrawUiPopoverContent>
    </TldrawUiPopover>
  );
}
