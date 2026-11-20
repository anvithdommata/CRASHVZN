import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath, URL } from "node:url";

/**
 * Content-Security-Policy for the renderer, written into index.html as a <meta> tag (Electron's
 * loadFile serves no headers). Nothing remote is loaded: Spark compiles WebAssembly and starts
 * workers from blob:/data: URLs, footage plays from blob: object URLs, and the voice recorder loads
 * its AudioWorklet from a blob:. The dev server additionally needs Vite's HMR websocket and the
 * inline React Refresh preamble.
 */
function contentSecurityPolicy(dev: boolean): string {
  const self = dev ? "'self'" : "'self' file:";
  return [
    "default-src 'self'",
    `script-src ${self} 'wasm-unsafe-eval' blob:${dev ? " 'unsafe-inline'" : ""}`,
    `worker-src ${self} blob: data:`,
    `style-src ${self} 'unsafe-inline'`,
    `img-src ${self} data: blob:`,
    `media-src ${self} blob:`,
    `font-src ${self} data:`,
    `connect-src ${self} blob: data:${dev ? " ws://127.0.0.1:5173" : ""}`,
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
}

export default defineConfig(({ command }) => ({
  // Relative asset URLs: the packaged app loads dist/index.html over file://, where "/assets/…"
  // would resolve to the drive root and leave a blank window.
  base: "./",
  plugins: [
    react(),
    tailwindcss(),
    {
      name: "crashvzn-csp",
      transformIndexHtml: () => [
        { tag: "meta", attrs: { "http-equiv": "Content-Security-Policy", content: contentSecurityPolicy(command === "serve") }, injectTo: "head-prepend" },
      ],
    },
  ],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      // Pure modules from the assistant package (fast path, tool registry, entity matcher).
      "@assistant": fileURLToPath(new URL("../../packages/assistant/src", import.meta.url)),
    },
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    // The assistant package and the bundled test footage live outside the app folder.
    fs: { allow: [fileURLToPath(new URL("../..", import.meta.url))] },
  },
  optimizeDeps: {
    include: ["three", "@sparkjsdev/spark"],
  },
}));
