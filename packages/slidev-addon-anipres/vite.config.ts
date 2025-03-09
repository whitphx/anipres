// Load and save Tldraw snapshots from/to the file system via Vite plugin.
// This implmentation is based on the slidev-addon-graph plugin:
// https://github.com/antfu/slidev-addon-graph/blob/5c7dbfbf198c401477f9b50ce4de4e9e50243d16/vite.config.ts
import fs from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { defineConfig, type Plugin } from "vite";
import Font from "vite-plugin-font";

let root = process.cwd();
function resolveSnapshotPath() {
  return join(root, ".slidev/anipres/snapshots");
}

export default defineConfig(({ mode }) => ({
  optimizeDeps: {
    /*
     * In dev mode, Vite serves native ESM, so CommonJS packages like "react" don't expose named exports (e.g., useCallback) correctly,
     * which causes runtime errors like 'The requested module ... does not provide an export named ...'
     * when this package is used in the dev mode of Slidev.
     * Configuring `optimizeDeps` here tells Vite to pre-bundle these dependencies so that they behave as ES modules.
     *
     * References:
     * - Vite Dep Pre-Bundling: https://vitejs.dev/guide/dep-pre-bundling.html
     */
    include: [
      "slidev-addon-anipres > react",
      "slidev-addon-anipres > react-dom",
      "slidev-addon-anipres > react-dom/client",
      "slidev-addon-anipres > tldraw",
    ],
  },
  plugins: [
    {
      name: "set-font-subsets",
      resolveId(id) {
        if (id === "/@xiaolai-font.ttf") {
          // Enable extremely lightweight optimization (https://www.npmjs.com/package/vite-plugin-font#extremely-lightweight-optimization)
          // by adding `?subsets` to the font URL only in production mode.
          // This setting is effective in combination with the `scanFiles` option of the `Font.vite` plugin below.
          // We use this plugin-based approach to modify the module name dynamically at build time.
          const xiaolaiFontPath = join(
            __dirname,
            "./assets/fonts/XiaolaiSC-Regular.ttf",
          );
          return xiaolaiFontPath + (mode === "production" ? "?subsets" : "");
        }
      },
    },
    Font.vite({
      // Enable optimization only in production mode. See the comment in the `resolveId` hook above.
      scanFiles:
        mode === "production"
          ? ["**/.slidev/anipres/snapshots/*.json"]
          : undefined,
    }) as Plugin,
    {
      name: "anipres-server",
      configureServer(server) {
        root = server.config.root;
        server.ws.on("connection", (socket) => {
          socket.on("message", async (data) => {
            const payload = JSON.parse(data.toString());
            if (
              payload.type === "custom" &&
              payload.event === "anipres-snapshot"
            ) {
              const snapshotDir = resolveSnapshotPath();
              const snapshotData = JSON.stringify(
                payload.data.snapshot,
                null,
                2,
              );
              fs.mkdirSync(snapshotDir, { recursive: true });
              fs.writeFileSync(
                join(snapshotDir, `${payload.data.id}.json`),
                snapshotData,
              );
              // Invalidate the module so that the saved snapshot is loaded on the next request.
              const mod = server.moduleGraph.getModuleById(
                "/@slidev-anipres-snapshot",
              );
              if (mod) server.moduleGraph.invalidateModule(mod);
            }
          });
        });
      },
      configResolved(config) {
        root = config.root;
      },
      resolveId(id) {
        if (id === "/@slidev-anipres-snapshot") {
          return id;
        }
      },
      load(id) {
        if (id === "/@slidev-anipres-snapshot") {
          const path = resolveSnapshotPath();
          const files = fs.existsSync(path) ? fs.readdirSync(path) : [];
          return [
            "",
            ...files.map((file, idx) => {
              return `import v${idx} from ${JSON.stringify(join(path, file))}`;
            }),
            "const snapshots = {",
            files
              .map((file, idx) => {
                return `  ${JSON.stringify(file.replace(/\.json$/, ""))}: v${idx}`;
              })
              .join(",\n"),
            "}",

            "export default snapshots",

            "if (import.meta.hot) {",
            "  import.meta.hot.accept(({ default: newSnapshots }) => {",
            "    Object.assign(snapshots, newSnapshots)",
            "  })",
            "}",
          ].join("\n");
        }
      },
    },
  ],
}));
