declare module "virtual:ritween-project" {
  export const authoredSettings:
    import("./engine/types").ProjectSettings | undefined;
  export const savedSettings: import("./engine/types").ProjectSettings;
  export const project: import("./engine/types").Project;
}
declare module "virtual:ritween-sources" {
  /** Scene `source` label to file text. Null means the path could not be read. */
  export const sources: Record<string, string | null>;
}
