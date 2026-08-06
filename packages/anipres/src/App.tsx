import { useCallback } from "react";
import { Editor, createShapeId, uniqueId } from "tldraw";
import { CueFrame, SubFrame } from "./timeline-model";
import { Anipres } from "./Anipres.tsx";

function setupDevMock(editor: Editor) {
  // Demo steps: rect0 alone; rect1 + arrow0 fire simultaneously (one
  // shared step); then three arrow-only steps.
  const stepIds = [uniqueId(), uniqueId(), uniqueId(), uniqueId(), uniqueId()];
  const stepKeys = ["a0", "a1", "a2", "a3", "a4"];
  const rect0Id = createShapeId("rect0");
  const rectTrackId = uniqueId();
  editor.createShape({
    id: rect0Id,
    type: "geo",
    x: 100,
    y: 0,
    props: {
      w: 100,
      h: 50,
    },
    meta: {
      frame: {
        v: 2,
        id: uniqueId(),
        type: "cue",
        trackId: rectTrackId,
        stepId: stepIds[0],
        stepOrderKey: stepKeys[0],
        action: {
          type: "shapeAnimation",
        },
      } satisfies CueFrame,
    },
  });

  const rect1Id = createShapeId("rect1");
  const rect1FrameId = uniqueId();
  editor.createShape({
    id: rect1Id,
    type: "geo",
    x: 200,
    y: 0,
    props: {
      w: 100,
      h: 100,
    },
    meta: {
      frame: {
        v: 2,
        id: rect1FrameId,
        type: "cue",
        trackId: rectTrackId,
        stepId: stepIds[1],
        stepOrderKey: stepKeys[1],
        action: {
          type: "shapeAnimation",
          duration: 1000,
        },
      } satisfies CueFrame,
    },
  });

  const rect2Id = createShapeId("rect2");
  const rect2FrameId = uniqueId();
  editor.createShape({
    id: rect2Id,
    type: "geo",
    x: 300,
    y: 0,
    props: {
      w: 100,
      h: 150,
    },
    meta: {
      frame: {
        v: 2,
        id: rect2FrameId,
        type: "sub",
        cueFrameId: rect1FrameId,
        orderKey: "a0",
        action: {
          type: "shapeAnimation",
          duration: 2000,
        },
      } satisfies SubFrame,
    },
  });

  const rect3Id = createShapeId("rect3");
  const rect3FrameId = uniqueId();
  editor.createShape({
    id: rect3Id,
    type: "geo",
    x: 400,
    y: 0,
    props: {
      w: 100,
      h: 200,
    },
    meta: {
      frame: {
        v: 2,
        id: rect3FrameId,
        type: "sub",
        cueFrameId: rect1FrameId,
        orderKey: "a1",
        action: {
          type: "shapeAnimation",
          duration: 3000,
        },
      } satisfies SubFrame,
    },
  });

  const arrow0Id = createShapeId("arrow0");
  const arrowTrackId = uniqueId();
  editor.createShape({
    id: arrow0Id,
    type: "arrow",
    x: 0,
    y: 0,
    props: {
      start: {
        x: 0,
        y: 0,
      },
      end: {
        x: 100,
        y: 100,
      },
    },
    meta: {
      frame: {
        v: 2,
        id: uniqueId(),
        type: "cue",
        trackId: arrowTrackId,
        stepId: stepIds[1],
        stepOrderKey: stepKeys[1],
        action: {
          type: "shapeAnimation",
        },
      } satisfies CueFrame,
    },
  });

  const arrow1Id = createShapeId("arrow1");
  editor.createShape({
    id: arrow1Id,
    type: "arrow",
    x: 0,
    y: 100,
    props: {
      start: {
        x: 0,
        y: 0,
      },
      end: {
        x: 200,
        y: 200,
      },
    },
    meta: {
      frame: {
        v: 2,
        id: uniqueId(),
        type: "cue",
        trackId: arrowTrackId,
        stepId: stepIds[2],
        stepOrderKey: stepKeys[2],
        action: {
          type: "shapeAnimation",
          duration: 1000,
        },
      } satisfies CueFrame,
    },
  });

  const arrow2Id = createShapeId("arrow2");
  editor.createShape({
    id: arrow2Id,
    type: "arrow",
    x: 200,
    y: 200,
    props: {
      start: {
        x: 0,
        y: 0,
      },
      end: {
        x: 300,
        y: 100,
      },
    },
    meta: {
      frame: {
        v: 2,
        id: uniqueId(),
        type: "cue",
        trackId: arrowTrackId,
        stepId: stepIds[3],
        stepOrderKey: stepKeys[3],
        action: {
          type: "shapeAnimation",
        },
      } satisfies CueFrame,
    },
  });

  const arrow3Id = createShapeId("arrow3");
  editor.createShape({
    id: arrow3Id,
    type: "arrow",
    x: 300,
    y: 100,
    props: {
      start: {
        x: 0,
        y: 0,
      },
      end: {
        x: 400,
        y: 200,
      },
    },
    meta: {
      frame: {
        v: 2,
        id: uniqueId(),
        type: "cue",
        trackId: arrowTrackId,
        stepId: stepIds[4],
        stepOrderKey: stepKeys[4],
        action: {
          type: "shapeAnimation",
          duration: 1000,
        },
      } satisfies CueFrame,
    },
  });

  const childBoxId11 = createShapeId("childBox11");
  editor.createShape({
    id: childBoxId11,
    type: "geo",
    x: 500,
    y: 500,
    props: {
      w: 80,
      h: 50,
    },
  });

  const childBoxId12 = createShapeId("childBox12");
  editor.createShape({
    id: childBoxId12,
    type: "geo",
    x: 540,
    y: 520,
    props: {
      w: 50,
      h: 80,
      color: "red",
    },
  });

  const groupId1 = createShapeId("groupShape1");
  editor.groupShapes([childBoxId11, childBoxId12], {
    groupId: groupId1,
  });

  const childBoxId21 = createShapeId("childBox21");
  editor.createShape({
    id: childBoxId21,
    type: "geo",
    x: 600,
    y: 500,
    props: {
      w: 80,
      h: 50,
    },
  });

  const childBoxId22 = createShapeId("childBox22");
  editor.createShape({
    id: childBoxId22,
    type: "geo",
    x: 640,
    y: 520,
    props: {
      w: 50,
      h: 80,
      color: "red",
    },
  });

  const groupId2 = createShapeId("groupShape2");
  editor.groupShapes([childBoxId21, childBoxId22], {
    groupId: groupId2,
  });

  const parentGroupId = createShapeId("parentGroup");
  editor.groupShapes([groupId1, groupId2], {
    groupId: parentGroupId,
  });
}

function App() {
  const handleMount = useCallback((editor: Editor) => {
    setupDevMock(editor);
  }, []);

  return (
    <div style={{ position: "fixed", inset: 0 }}>
      <Anipres onMount={handleMount} />
    </div>
  );
}

export default App;
