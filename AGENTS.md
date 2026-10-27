# AGENTS.md

## Project Structure & Module Organization

Ritween is a code-first WebGPU video framework built with TypeScript, React, and Vite.

- `src/engine/`: timeline evaluation, GPU rendering, audio mixing, encoding, and MP4 muxing.
- `src/project/`: composition manifest, scene modules, and procedural audio.
- `src/preview/`: studio UI organized by feature, with shared components, hooks, state, and utilities. Follow `src/preview/README.md` when placing files.
- `bin/` and `cli/`: Node CLI entry point and supporting implementation.
- `tests/`: unit tests; `scripts/`: browser validation and benchmarks.
- `dist/`: generated build; `artifacts/`: ignored validation outputs and exported media.

## Build, Test, and Development Commands

Use Node.js 20.19+ or 22.12+ and install dependencies with `npm ci`.

- `npm run dev`: start Vite at `http://localhost:5173`.
- `npm run build`: run TypeScript checks and produce the production build.
- `npm run preview`: serve the production build.
- `npm test`: run all `tests/*.test.ts` through `tsx` and Node’s test runner.
- `npm run test:preview`: validate studio preview behavior.
- `npm run test:browser`: validate real GPU rendering, encoding, playback, and seeking; start Vite first and install Chrome.
- `npm run cli -- frame --time 5.2 -o artifacts/frame.png`: render a frame through the local CLI.

## Coding Style & Naming Conventions

Use strict TypeScript, two-space indentation, double quotes, and semicolons, matching existing code. Prettier is available; no dedicated lint script is configured. Use kebab-case filenames, PascalCase React components, and `use-` filenames for hooks. Keep feature implementations in their owning preview folders. Shared modules must not import feature implementations or `app.tsx`.

## Testing Guidelines

Add descriptive behavior tests in `tests/<feature>.test.ts` using `node:test` and `node:assert/strict`. Cover timing boundaries, invalid inputs, and export invariants when changing engine behavior. Run `npm test` and `npm run build` before submitting; run relevant browser validation for rendering or codec changes. No numeric coverage threshold is configured. Browser validation requires WebGPU, WebCodecs, and GPU acceleration; `BASE_URL` and `CHROME_CHANNEL` override defaults.

## Commit & Pull Request Guidelines

History mixes imperative summaries with scoped prefixes such as `refactor(preview): ...`; use concise, specific messages consistent with the affected area. PRs should explain the behavior change, link relevant issues, and report validation performed. Include screenshots for studio UI changes and media artifacts or benchmark results when they substantiate rendering or export changes.
