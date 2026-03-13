# Repository Guidelines

## Project Structure & Module Organization

- Monorepo managed by pnpm (`pnpm-workspace.yaml`). Primary packages live in `packages/`.
- `packages/anipres`: React/TypeScript library with Vite build and Vitest tests; ships compiled assets in `dist/`.
- `packages/app`: Web app showcasing the library; Vite-based.
- `packages/slidev-addon-anipres`: Slidev addon that embeds the library; ships Vue/React hybrid components and assets.

## Build, Test, and Development Commands

- Install: `pnpm install` (Node version specified in `.nvmrc`).
- Library dev: `pnpm --filter anipres dev`; build: `pnpm --filter anipres build`; preview: `pnpm --filter anipres preview`.
- App dev: `pnpm --filter app dev`; build: `pnpm --filter app build`.
- Slidev addon demo: `pnpm --filter slidev-addon-anipres dev`.
- Tests (Vitest in library): `pnpm --filter anipres test`; add `--watch` while iterating.
- Lint/format: `pnpm --filter anipres lint`; `pnpm --filter anipres format` (Prettier). Markdown is auto-formatted via lint-staged on commit.

## Coding Style & Naming Conventions

- TypeScript across packages; prefer `*.tsx` for React views and `*.ts` for logic.
- Formatting enforced by Prettier 3; keep imports sorted logically and avoid lint overrides unless necessary.
- ESLint flat configs with React, React Hooks, and Prettier plugins; fix warnings before merging.
- Lint-staged: Prettier + ESLint run on commit via husky
- Component/utility files use kebab- or dash-separated filenames (e.g., `ordered-track-item.ts`); exported symbols in PascalCase for components and camelCase for helpers.
- Styling: CSS Modules (`.module.scss`, `.module.css`)
- File naming: Mixed — React components and their files use PascalCase (e.g. `Anipres.tsx`, `App.tsx`), most other modules use kebab-case; camelCase for helpers. Prefer the existing convention in a given folder.
- Tests: Vitest, co-located with source (`*.test.ts`)
- TypeScript: Strict mode, `noUnusedLocals`, `noUnusedParameters` enabled

## Implementation Patterns

- **State management**:
  - Tldraw has its own signal-based state management system using atoms and computed values.
  - For editor-related state (shapes, selection, frames, presentation progress, etc.), rely on tldraw's atom/computed system (and hooks like `useAtom` / `useValue`) instead of duplicating that state in React.
  - Use React state only for view-level concerns that are independent of the tldraw editor (for example, local UI toggles, dialog visibility, or layout switches).
## Architecture

### Core Library (`packages/anipres/src/`)

**Shape System** (`src/shapes/`): Custom tldraw shapes, each with a type definition file (pure TS), a `ShapeUtil` (rendering/behavior), and a `ShapeTool` (creation interaction).

**Presentation Manager** (`src/presentation-manager/`): Manages animation sequencing and frame state. Uses tldraw's atom/computed system for reactive state. Instances are cached per-editor via WeakMap.

**Models** (`src/models.ts`): Core data types — FrameAction (shapeAnimation, cameraZoom), Frame types (CueFrame with ordered track items, SubFrame), and Step (array of frame batches).

**Timeline UI** (`src/Timeline/`): Frame editor with drag-and-drop via @dnd-kit.

**Control Panel** (`src/ControlPanel/`): Step navigation, presentation mode trigger, timeline widget.

**Main Component** (`src/Anipres.tsx`): Top-level React component that integrates tldraw with custom shapes, tools, and UI overrides. Uses per-instance atoms for state isolation.

## Testing Guidelines

- Vitest unit tests live beside sources in `packages/*/src/*.{test,spec}.ts`.
- Cover new behaviors with focused unit tests; prefer deterministic tests without timers or network.
- Run `pnpm test` before PRs; keep tests green on CI.
- After making changes, run `pnpm typecheck` to validate types. If the script is missing, note the failure in your summary and proceed with the available checks.

## Commit & Pull Request Guidelines

- Commit messages should be clear, concise, and descriptive.
- For user-facing or API changes, add a Changeset: `pnpm changeset` (targets `main` base branch).
- Ensure lint, build, and tests pass locally.
- PRs should describe motivation, key changes, and testing done; link related issues or PR numbers in the description.
