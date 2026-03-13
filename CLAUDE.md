# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Anipres is a whiteboard-style animation and presentation tool built on tldraw. It's a pnpm monorepo with three packages:

- **`packages/anipres`**: Core React/TypeScript library. Extends tldraw with custom shapes (SlideShape, ThemeImageShape), animation/presentation management, and timeline UI. Published to npm.
- **`packages/app`**: Vite-based web app ([anipres.app](https://anipres.app)) showcasing the library. Uses IndexedDB (idb-keyval) for document persistence.
- **`packages/slidev-addon-anipres`**: Slidev addon that embeds anipres in Slidev presentations. Vue/React hybrid using veaury bridge.

## Development Commands

Node version is specified in `.nvmrc`. Install dependencies with `pnpm install`.

### anipres library (primary development target)

```
pnpm -F anipres dev          # Vite dev server
pnpm -F anipres build        # tsc -b && vite build
pnpm -F anipres test         # Vitest (add --watch for dev)
pnpm -F anipres test -- src/models.test.ts  # Run a single test file
pnpm -F anipres typecheck    # tsc type checking
pnpm -F anipres lint         # ESLint
pnpm -F anipres format       # Prettier (--write)
```

### app

```
pnpm -F app dev
pnpm -F app build
pnpm -F app lint
```

### slidev-addon-anipres

```
pnpm -F slidev-addon-anipres dev   # Slidev dev mode
pnpm -F slidev-addon-anipres lint
```

### Versioning

For user-facing or API changes, add a changeset: `pnpm changeset` (base branch: `main`).

## Architecture

### Core Library (`packages/anipres/src/`)

**Shape System** (`src/shapes/`): Custom tldraw shapes, each with a type definition file (pure TS), a `ShapeUtil` (rendering/behavior), and a `ShapeTool` (creation interaction).

**Presentation Manager** (`src/presentation-manager/`): Manages animation sequencing and frame state. Uses tldraw's atom/computed system for reactive state. Instances are cached per-editor via WeakMap.

**Models** (`src/models.ts`): Core data types — FrameAction (shapeAnimation, cameraZoom), Frame types (CueFrame with ordered track items, SubFrame), and Step (array of frame batches).

**Timeline UI** (`src/Timeline/`): Frame editor with drag-and-drop via @dnd-kit.

**Control Panel** (`src/ControlPanel/`): Step navigation, presentation mode trigger, timeline widget.

**Main Component** (`src/Anipres.tsx`): Top-level React component that integrates tldraw with custom shapes, tools, and UI overrides. Uses per-instance atoms for state isolation.

### Key Patterns

- **State management**: tldraw's atom system with `@computed` for memoization
- **Styling**: CSS Modules (`.module.scss`, `.module.css`)
- **File naming**: kebab-case for files, PascalCase for components/classes, camelCase for helpers
- **Tests**: Vitest, co-located with source (`*.test.ts`)
- **TypeScript**: Strict mode, `noUnusedLocals`, `noUnusedParameters` enabled
- **Lint-staged**: Prettier + ESLint run on commit via husky
