import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { projectPlugin } from "./cli/project.ts";
import { fileURLToPath } from "node:url";
export default defineConfig({
  plugins: [
    projectPlugin(
      fileURLToPath(new URL("./src/project/manifest.ts", import.meta.url)),
      fileURLToPath(
        new URL("./src/engine/project-settings-schema.ts", import.meta.url),
      ),
    ),
    react(),
    tailwindcss(),
  ],
});
