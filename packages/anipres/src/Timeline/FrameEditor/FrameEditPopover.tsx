import {
  EASINGS,
  TldrawUiPopover,
  TldrawUiPopoverTrigger,
  TldrawUiPopoverContent,
} from "tldraw";
import {
  MEDIA_CONTROL_COMMANDS,
  type MediaControlCommand,
  type MediaControlFrameAction,
} from "../../timeline-model";
import type { FrameUIData } from "../frame-ui-data";
import { NumberField } from "./NumberField";
import { SelectField } from "./SelectField";
import styles from "./FrameEditPopover.module.scss";

const EASINGS_OPTIONS = Object.keys(EASINGS);
function isEasingOption(value: string): value is keyof typeof EASINGS {
  return EASINGS_OPTIONS.includes(value);
}

function isMediaControlCommand(value: string): value is MediaControlCommand {
  return (MEDIA_CONTROL_COMMANDS as readonly string[]).includes(value);
}

/**
 * Rebuilds a valid mediaControl action for a new command: `volume` is
 * only allowed alongside setVolume, so it must be added/stripped rather
 * than spread through.
 */
function withCommand(
  action: MediaControlFrameAction,
  command: MediaControlCommand,
): MediaControlFrameAction {
  return {
    type: "mediaControl",
    command,
    ...(action.duration !== undefined ? { duration: action.duration } : {}),
    ...(command === "setVolume" ? { volume: action.volume ?? 100 } : {}),
  };
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
          {frame.action.type === "mediaControl" && (
            <>
              <SelectField
                label="Command"
                value={frame.action.command}
                options={[...MEDIA_CONTROL_COMMANDS]}
                onChange={(newCommand) => {
                  if (
                    frame.action.type === "mediaControl" &&
                    isMediaControlCommand(newCommand)
                  ) {
                    onUpdate({
                      ...frame,
                      action: withCommand(frame.action, newCommand),
                    });
                  }
                }}
              />
              {frame.action.command === "setVolume" && (
                <NumberField
                  label="Volume"
                  value={frame.action.volume ?? 100}
                  onChange={(newVolume) =>
                    onUpdate({
                      ...frame,
                      action: {
                        ...frame.action,
                        volume: Math.min(100, Math.max(0, newVolume)),
                      },
                    })
                  }
                />
              )}
            </>
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
          {frame.action.type !== "mediaControl" && (
            <SelectField
              label="Easing"
              value={frame.action.easing ?? ""}
              options={EASINGS_OPTIONS}
              onChange={(newEasing) => {
                if (
                  frame.action.type !== "mediaControl" &&
                  isEasingOption(newEasing)
                ) {
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
          )}
        </div>
      </TldrawUiPopoverContent>
    </TldrawUiPopover>
  );
}
