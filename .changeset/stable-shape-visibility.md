---
"anipres": patch
---

Keep the editor alive across re-renders: `getShapeVisibility` is part of tldraw's editor-creation dependency list, so the previously inline callback made every re-render of `Anipres` dispose and recreate the `Editor` — on a synced store, every WebSocket reconnect did this, clearing undo history and remounting the canvas mid-presentation.
