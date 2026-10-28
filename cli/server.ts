import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve, dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { ResolvedProject } from "./project.ts";
import { projectPlugin } from "./project.ts";
export async function startServer({
  runtimeRoot,
  project,
  port = 0,
}: {
  runtimeRoot: string;
  project: ResolvedProject;
  port?: number;
}) {
  const cache = await mkdtemp(join(tmpdir(), "ritween-vite-"));
  let server;
  const builtRoot = join(runtimeRoot, "dist");
  try {
    server = await createServer({
      configFile: false,
      root: builtRoot,
      logLevel: "silent",
      cacheDir: join(cache, "node_modules/.vite"),
      publicDir: existsSync(join(project.directory, "public"))
        ? join(project.directory, "public")
        : existsSync(join(builtRoot, "public"))
          ? join(builtRoot, "public")
          : false,
      plugins: [
        projectPlugin(project.manifest, join(builtRoot, "schema.js"), true),
        {
          name: "ritween-built-runtime-reload",
          handleHotUpdate(context) {
            if (!context.file.startsWith(builtRoot + "/")) {
              context.server.ws.send({ type: "full-reload" });
              return [];
            }
          },
        },
        react(),
        tailwindcss(),
        {
          name: "ritween-render-shell",
          configureServer(server) {
            server.middlewares.use(
              "/__ritween/render",
              async (req, res, next) => {
                if (req.method !== "GET") return next();
                try {
                  const html = await server.transformIndexHtml(
                    "/__ritween/render",
                    '<!doctype html><html><head><meta charset="utf-8"><title>Ritween renderer</title></head><body><script type="module" src="/renderer.js"></script></body></html>',
                  );
                  res.setHeader("Content-Type", "text/html");
                  res.end(html);
                } catch (error) {
                  next(error);
                }
              },
            );
          },
        },
      ],
      resolve: {
        alias: [
          {
            find: /^ritween$/,
            replacement: resolve(builtRoot, "index.js"),
          },
        ],
        dedupe: ["react", "react-dom"],
      },
      server: {
        host: "127.0.0.1",
        port,
        fs: {
          allow: [runtimeRoot, project.directory, dirname(project.manifest)],
        },
      },
    });
    await server.listen();
  } catch (error) {
    await server?.close().catch(() => {});
    await rm(cache, { recursive: true, force: true });
    throw error;
  }
  const originalClose = server.close.bind(server);
  server.close = async () => {
    try {
      await originalClose();
    } finally {
      await rm(cache, { recursive: true, force: true });
    }
  };
  const address = server.httpServer?.address();
  if (!address || typeof address === "string")
    throw Error("Preview server did not bind a TCP port.");
  return { server, url: `http://127.0.0.1:${address.port}` };
}
