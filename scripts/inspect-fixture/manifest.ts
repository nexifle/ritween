/**
 * Fixture manifest. Fonts are registered at module evaluation, before the CLI
 * creates any Renderer/Stage, because Stage resolves `document.fonts.check` during
 * setup and frame preparation. The proof result is published on `loadFixtureFonts`
 * so the validation script can assert both weights really rasterized.
 */
import { project as composed, loadFonts } from "./scenes.ts";
export const fontProof = await loadFonts();
export const project = composed;
export default project;
