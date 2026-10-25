import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve, dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { projectPlugin } from "./project.mjs";
export async function startServer({ runtimeRoot, project, port = 0 }) {
  const cache = await mkdtemp(join(tmpdir(), "rimotion-vite-"));
  let server;
  try {
    server = await createServer({
      configFile: false,
      root: runtimeRoot,
      logLevel: "silent",
      cacheDir: join(cache, "node_modules/.vite"),
      publicDir: existsSync(join(project.directory, "public"))
        ? join(project.directory, "public")
        : false,
      plugins: [
        projectPlugin(project.manifest),
        react(),
        tailwindcss(),
        {
          name: "rimotion-render-shell",
          configureServer(server) {
            server.middlewares.use(
              "/__rimotion/render",
              async (req, res, next) => {
                if (req.method !== "GET") return next();
                try {
                  const html = await server.transformIndexHtml(
                    "/__rimotion/render",
                    '<!doctype html><html><head><meta charset="utf-8"><title>Rimotion renderer</title></head><body><script type="module" src="/src/cli-browser.ts"></script></body></html>',
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
            find: /^rimotion$/,
            replacement: resolve(runtimeRoot, "src/index.ts"),
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
  const address = server.httpServer.address();
  return { server, url: `http://127.0.0.1:${address.port}` };
}
