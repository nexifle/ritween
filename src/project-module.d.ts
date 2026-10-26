declare module "virtual:rimotion-project" {
  export const project: import("./engine/types").Project;
}
declare module "virtual:rimotion-sources" {
  /** Scene `source` label to file text. Null means the path could not be read. */
  export const sources: Record<string, string | null>;
}
