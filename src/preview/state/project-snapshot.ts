import type { Project, ProjectSettings } from "../../engine/types";

export interface ProjectSnapshot {
  project: Project;
  authoredSettings: ProjectSettings | undefined;
  savedSettings: ProjectSettings;
  sources: Record<string, string | null>;
  revision: number;
  error: string;
}
