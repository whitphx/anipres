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
- Component/utility files use kebab- or dash-separated filenames (e.g., `ordered-track-item.ts`); exported symbols in PascalCase for components and camelCase for helpers.

## Testing Guidelines

- Vitest unit tests live beside sources in `packages/anipres/src/*.{test,spec}.ts`.
- Cover new behaviors with focused unit tests; prefer deterministic tests without timers or network.
- Run `pnpm --filter anipres test` before PRs; keep tests green on CI.
- After making changes, run `pnpm typecheck` to validate types. If the script is missing, note the failure in your summary and proceed with the available checks.

## Commit & Pull Request Guidelines

- Commit messages should be clear, concise, and descriptive.
- For user-facing or API changes, add a Changeset: `pnpm changeset` (targets `main` base branch).
- Ensure lint, build, and tests pass locally.
- PRs should describe motivation, key changes, and testing done; link related issues or PR numbers in the description.
