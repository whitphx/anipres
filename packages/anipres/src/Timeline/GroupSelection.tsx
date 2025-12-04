import { useState, useEffect } from "react";
import type { ShapeSelection } from "./selection";

function unionRect(rects: DOMRect[]) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const rect of rects) {
    if (rect.left < minX) {
      minX = rect.left;
    }
    if (rect.top < minY) {
      minY = rect.top;
    }
    if (rect.right > maxX) {
      maxX = rect.right;
    }
    if (rect.bottom > maxY) {
      maxY = rect.bottom;
    }
  }

  return new DOMRect(minX, minY, maxX - minX, maxY - minY);
}

interface GroupSelectionProps {
  groupSelection: ShapeSelection;
  containerRef: React.RefObject<HTMLElement>;
  frameEditorsRef: React.RefObject<Record<string, HTMLElement>>;
  requestCueFrameAddAfter: (shapeSelection: ShapeSelection) => void;
}
export function GroupSelection(props: GroupSelectionProps) {
  const [groupRect, setGroupRect] = useState<DOMRect | null>(null);

  useEffect(() => {
    const container = props.containerRef.current;
    if (!container) {
      return;
    }

    const containerRect = container.getBoundingClientRect();

    const rects = props.groupSelection.frameIds
      .map((frameId) => {
        const elem =
          props.frameEditorsRef.current &&
          props.frameEditorsRef.current[frameId];
        return elem ? elem.getBoundingClientRect() : null;
      })
      .filter((rect): rect is DOMRect => rect !== null);

    if (rects.length === 0) {
      setGroupRect(null);
      return;
    }

    const groupRect = unionRect(rects);
    groupRect.x -= containerRect.x;
    groupRect.y -= containerRect.y;

    setGroupRect(groupRect);
  }, [props.groupSelection.frameIds]);

  if (groupRect == null) {
    return null;
  }

  return (
    <div
      style={{
        position: "absolute",
        left: groupRect.left,
        top: groupRect.top,
        width: groupRect.width,
        height: groupRect.height,
        border: "2px dashed blue",
        pointerEvents: "none",
      }}
    >
      <button
        onClick={() => props.requestCueFrameAddAfter(props.groupSelection)}
        style={{
          pointerEvents: "auto",
        }}
      >
        Add Cue Frame
      </button>
    </div>
  );
}
