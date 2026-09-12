import { build } from "vite";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");

export async function buildDesktopBackend(): Promise<void> {
  console.log("Building desktop local companion backend bundle...");
  await build({
    configFile: false,
    root: rootDir,
    build: {
      ssr: true,
      target: "node22",
      lib: {
        entry: path.resolve(rootDir, "src/desktop/localServer.ts"),
        formats: ["cjs"],
        fileName: () => "localServer.cjs",
      },
      outDir: path.resolve(rootDir, "desktop/electron/dist-backend"),
      emptyOutDir: true,
      rollupOptions: {
        external: (id) => {
          // Node built-in modules
          if (
            id.startsWith("node:") ||
            [
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
            ].includes(id)
          ) {
            return true;
          }
          // Externalize all node_modules dependencies
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
        },
      },
    },
  });
  console.log("Desktop local companion backend bundle built successfully.");
}

if (process.argv[1]?.includes("build_desktop_backend")) {
  buildDesktopBackend().catch((err) => {
    console.error("Backend build failed:", err);
    process.exit(1);
  });
}
