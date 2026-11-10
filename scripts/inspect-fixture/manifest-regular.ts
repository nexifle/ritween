/**
 * Same consumer project rendered with weight-400 titles. The validation script runs
 * both manifests and compares the inspected `title` width, which proves the fixture
 * font's 400 and 700 faces are both loaded and rasterize distinctly through the real
 * CLI — a fractional width alone could come from any font.
 */
import { createProject, loadFonts } from "./scenes.ts";
export const fontProof = await loadFonts();
export const project = createProject(400);
export default project;
