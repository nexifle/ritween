# Preview studio

`app.tsx` is the entry point and coordinates rendering, audio, application state,
and the studio panels.

| Folder | Responsibility |
| --- | --- |
| `composition/` | Composition canvas viewer, zoom, and pan interactions. |
| `timeline/` | Timeline, clip lanes, and track headers. |
| `playback/` | Playback transport and master audio controls. |
| `source/` | Scene source inspector and syntax highlighting. |
| `export/` | Video export settings and progress panel. |
| `layout/` | Studio header, footer, dock arrangement, and project heading. |
| `components/` | Shared UI primitives and control styles used across features. |
| `hooks/` | Shared React hooks; filenames start with `use-`. |
| `state/` | Preview state, actions, and reducer. |
| `utils/` | Shared pure view calculations and time formatting. |

## Where to place new files

Start with the file's responsibility, rather than whether it renders JSX.

- **Feature folders:** Keep components, hooks, types, and helpers that belong to
  one feature together. For example, `LaneBlock` belongs in `timeline/`, export
  settings UI belongs in `export/`, and source highlighting belongs in `source/`.
  A component does not belong in `components/` simply because it is a React
  component or has been extracted from a larger file.
- **`components/`:** Put UI primitives here when they serve multiple features
  and have no dependency on a particular feature's implementation. Examples are
  `Icon`, `SidebarPanel`, and resizable panel primitives. Pass content and behavior
  through props rather than importing feature components or application state.
  Existing shared primitives may be extended here; new feature-specific UI should
  stay in its feature until another feature actually needs the same abstraction.
- **`layout/`:** Put studio-wide structure and chrome here, such as the header,
  footer, project heading, and dock arrangement. A feature panel's internal layout
  stays in that feature's folder.
- **Shared logic:** Use `hooks/` for hooks used across features, `utils/` for shared
  pure calculations and formatting, and `state/` for studio-wide state, actions,
  and reducers. Feature-specific equivalents stay with their feature.
- **`app.tsx`:** Keep application coordination and panel composition here. Place
  new UI implementations in the appropriate folder rather than growing this file.

Usage count alone does not determine ownership. A feature component can be rendered
in several places and still belong to its feature. Move it to `components/` only
when the shared part has a clear, feature-independent purpose; keep any feature
integration in the owning feature folder.

## Folder and naming conventions

Use kebab-case filenames, PascalCase React component names, and `use-` filenames
for hooks. Prefer names that describe the file's purpose, such as
`export-panel.tsx`, `preview-state.ts`, and `control-styles.ts`.

Use the existing feature folder when extending that feature. Create a new feature
folder for a distinct studio capability, even if it initially contains one file;
do not create folders for every individual component. Add nested folders only when
the feature grows enough to have meaningful groups of files.

Use explicit imports from the owning module. Shared modules in `components/`,
`hooks/`, and `utils/` should not import feature implementations or `app.tsx`.
Feature modules may import shared modules, and `app.tsx` assembles the features.
