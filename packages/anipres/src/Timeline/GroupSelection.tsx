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
  frameEditorDOMs: HTMLElement[];
  requestCueFrameAddAfter: (shapeSelection: ShapeSelection) => void;
}
export function GroupSelection(props: GroupSelectionProps) {
  const container = props.containerRef.current;
  if (!container) {
    return null;
  }

  const containerRect = container.getBoundingClientRect();

  const rects = props.frameEditorDOMs
    .map((elem) => {
      return elem ? elem.getBoundingClientRect() : null;
    })
    .filter((rect): rect is DOMRect => rect !== null);

  if (rects.length === 0) {
    return null;
  }

  const groupRect = unionRect(rects);
  groupRect.x -= containerRect.x;
  groupRect.y -= containerRect.y;

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
          position: "absolute",
          left: "100%",
          top: "50%",
          transform: "translate(0, -50%)",
        }}
      >
        +
      </button>
    </div>
  );
}
