import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { defineConfig, type Plugin } from "vite";
import Font from "vite-plugin-font";
import regexpEscape from "regexp.escape";

const fontDirPath = path.join(__dirname, "./assets/fonts/");

const xiaolaiFontPath = path.join(fontDirPath, "XiaolaiSC-Regular.ttf");

// In the production build, the font path passed to the font plugin is a relative path like "../../node_modules/...", not a full path like "/Users/.../node_modules/...".
// So we need to omit the path segment before `node_modules` from the query regex to match the relative path.
const fontDirPathFromNodeModules = fontDirPath.replace(
  /^.*(?=\/node_modules\/)/,
  "",
);
const fontDirPathRx = new RegExp(
  regexpEscape(fontDirPathFromNodeModules) + ".*\\.ttf(\\?.*)?$",
);

let root = process.cwd();
function resolveSnapshotPath() {
  return path.join(root, ".slidev/anipres/snapshots");
}

function isPathIn(target: string, maybeParent: string) {
  const relative = path.relative(maybeParent, target);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative);
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
          console.debug(`Resolve ${id} as ${xiaolaiFontPath}`);

          // Enable extremely lightweight optimization (https://www.npmjs.com/package/vite-plugin-font#extremely-lightweight-optimization)
          // by adding `?subsets` to the font URL only in production mode.
          // This setting is effective in combination with the `scanFiles` option of the `Font.vite` plugin below.
          // We use this plugin-based approach to modify the module name dynamically at build time.
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
      // `node_modules` is excluded by default, which is not good in our case where the font file will be in `node_modules` when this package is installed to user's environment by a package manager.
      // So we unset the `exclude` option to override the default behavior.
      exclude: [],
      // Also we set a stricter include path explicitly to avoid unexpected side effects from setting `exclude` to `[]`.
      include: [fontDirPathRx],
    }) as Plugin,
    {
      // Load and save Tldraw snapshots from/to the file system via Vite plugin.
      // This implementation is based on slidev-addon-graph:
      // https://github.com/antfu/slidev-addon-graph/blob/5c7dbfbf198c401477f9b50ce4de4e9e50243d16/vite.config.ts
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
                path.join(snapshotDir, `${payload.data.id}.json`),
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
          const snapshotPath = resolveSnapshotPath();
          const files = fs.existsSync(snapshotPath)
            ? fs.readdirSync(snapshotPath)
            : [];
          return [
            "",
            ...files.map((file, idx) => {
              return `import v${idx} from ${JSON.stringify(path.join(snapshotPath, file))}`;
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
  build: {
    rollupOptions: {
      onwarn(warning, warn) {
        // Vite reports a missing export just as a warning,
        // but we want to treat it as an error so that the build fails
        // in the case where the missing export is a font file.
        // because it leads to an error and broken styles at runtime.
        if (warning.code === "MISSING_EXPORT") {
          if (warning.exporter && isPathIn(warning.exporter, fontDirPath)) {
            throw new Error(`Build failed due to: ${warning.message}`);
          }
        }

        warn(warning);
      },
    },
  },
}));
