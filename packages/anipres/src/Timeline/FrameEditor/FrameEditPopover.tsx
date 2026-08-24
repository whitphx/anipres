import {
  EASINGS,
  TldrawUiPopover,
  TldrawUiPopoverTrigger,
  TldrawUiPopoverContent,
} from "tldraw";
import {
  MEDIA_CONTROL_COMMANDS,
  type MediaControlCommand,
} from "../../timeline-model";
import { DEFAULT_MEDIA_VOLUME } from "../../media/media-state";
import type { FrameUIData } from "../frame-ui-data";
import { withCommand } from "./media-command";
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

export interface FrameEditPopoverProps {
  frame: FrameUIData;
  onUpdate: (newFrame: FrameUIData) => void;
  /**
   * Deletes the event this frame represents. Offered only for media
   * events: their carrier shapes are invisible, so this popover is the
   * one place a user can remove one (other frames are removed by
   * deleting their shape on the canvas).
   */
  onDelete: () => void;
  children: React.ReactNode;
}
export function FrameEditPopover({
  frame,
  onUpdate,
  onDelete,
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
                  value={frame.action.volume ?? DEFAULT_MEDIA_VOLUME}
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
          {frame.action.type === "mediaControl" && (
            <button
              type="button"
              className={styles.deleteButton}
              onClick={onDelete}
            >
              Delete event
            </button>
          )}
        </div>
      </TldrawUiPopoverContent>
    </TldrawUiPopover>
  );
}
