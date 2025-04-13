import { useCallback } from "react";
import { Editor, createShapeId, uniqueId } from "tldraw";
import { CueFrame, SubFrame } from "./models";
import { Anipres } from "./Anipres.tsx";

function setupDevMock(editor: Editor) {
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
        id: uniqueId(),
        type: "cue",
        globalIndex: 0,
        trackId: rectTrackId,
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
        id: rect1FrameId,
        type: "cue",
        globalIndex: 1,
        trackId: rectTrackId,
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
        id: rect2FrameId,
        type: "sub",
        prevFrameId: rect1FrameId,
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
        id: rect3FrameId,
        type: "sub",
        prevFrameId: rect2FrameId,
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
        id: uniqueId(),
        type: "cue",
        globalIndex: 1,
        trackId: arrowTrackId,
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
        id: uniqueId(),
        type: "cue",
        globalIndex: 2,
        trackId: arrowTrackId,
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
        id: uniqueId(),
        type: "cue",
        globalIndex: 3,
        trackId: arrowTrackId,
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
        id: uniqueId(),
        type: "cue",
        globalIndex: 4,
        trackId: arrowTrackId,
        action: {
          type: "shapeAnimation",
          duration: 1000,
        },
      } satisfies CueFrame,
    },
  });

  const childBoxId1 = createShapeId("childBox1");
  editor.createShape({
    id: childBoxId1,
    type: "geo",
    x: 500,
    y: 500,
    props: {
      w: 80,
      h: 50,
    },
  });

  const childBoxId2 = createShapeId("childBox2");
  editor.createShape({
    id: childBoxId2,
    type: "geo",
    x: 540,
    y: 520,
    props: {
      w: 50,
      h: 80,
      color: "red",
    },
  });

  editor.groupShapes([childBoxId1, childBoxId2]);
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
