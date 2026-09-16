import { build } from "vite";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");

const BACKEND_OUT_DIR = path.resolve(rootDir, "desktop/electron/dist-backend");

const NODE_BUILTINS = new Set([
  "assert",
  "buffer",
  "child_process",
  "cluster",
  "crypto",
  "dgram",
  "dns",
  "events",
  "fs",
  "fs/promises",
  "http",
  "https",
  "net",
  "os",
  "path",
  "process",
  "querystring",
  "readline",
  "stream",
  "string_decoder",
  "tls",
  "url",
  "util",
  "v8",
  "vm",
  "zlib",
]);

function externalizeBackendDependency(id: string): boolean {
  if (id.startsWith("node:") || NODE_BUILTINS.has(id)) return true;
  // Keep repository source in the bundle while leaving runtime dependencies
  // such as pg and express resolvable from the installed application's node_modules.
  if (
    !id.startsWith(".") &&
    !id.startsWith("/") &&
    !id.startsWith("\\") &&
    !id.includes("Job-Decision-Engine-1") &&
    !id.includes("src")
  ) {
    return true;
  }
  return false;
}

interface BackendEntry {
  entry: string;
  fileName: string;
}

const BACKEND_ENTRIES: BackendEntry[] = [
  { entry: "src/desktop/localServer.ts", fileName: "localServer.cjs" },
  { entry: "scripts/process_pipeline_tasks.ts", fileName: "process_pipeline_tasks.cjs" },
  { entry: "scripts/evaluate_queue.ts", fileName: "evaluate_queue.cjs" },
  { entry: "scripts/reconcile_pipeline.ts", fileName: "reconcile_pipeline.cjs" },
];

export async function buildDesktopBackend(): Promise<void> {
  console.log("Building desktop local companion and worker bundles...");
  for (const [index, backendEntry] of BACKEND_ENTRIES.entries()) {
    await build({
      configFile: false,
      root: rootDir,
      build: {
        ssr: true,
        target: "node22",
        lib: {
          entry: path.resolve(rootDir, backendEntry.entry),
          formats: ["cjs"],
          fileName: () => backendEntry.fileName,
        },
        outDir: BACKEND_OUT_DIR,
        emptyOutDir: index === 0,
        rollupOptions: {
          external: externalizeBackendDependency,
        },
      },
    });
  }
  console.log("Desktop local companion and worker bundles built successfully.");
}

if (process.argv[1]?.includes("build_desktop_backend")) {
  buildDesktopBackend().catch((err) => {
    console.error("Backend build failed:", err);
    process.exit(1);
  });
}

