---
"anipres": minor
---

Expose anipres' shape building blocks for advanced consumers:

- The `anipres/schema` subpath now also exports `slideShapeProps`, `SlideShapeType`, `themeImageShapeProps`, and `ThemeImageShapeType` — pure-TS values usable outside React (e.g. validating snapshots on a server).
- The main entry now exports `customShapeUtils`, `allShapeUtils`, and `allBindingUtils` for embedders that build a tldraw editor with anipres' shapes plus their own.
