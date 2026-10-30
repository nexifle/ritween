import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { projectPlugin } from "./cli/project.ts";
import { fileURLToPath } from "node:url";
import { exportJobsPlugin } from "./cli/export-server.ts";
export default defineConfig({
  plugins: [
    exportJobsPlugin({
      runtimeRoot: fileURLToPath(new URL("./", import.meta.url)),
      project: {
        manifest: fileURLToPath(
          new URL("./src/project/manifest.ts", import.meta.url),
        ),
        directory: fileURLToPath(new URL("./", import.meta.url)),
      },
      sourceRuntime: true,
    }),
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
