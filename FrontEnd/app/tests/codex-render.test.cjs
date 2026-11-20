// After the --live vision test: FrontEnd/app/node_modules/electron/dist/electron.exe FrontEnd/app/tests/codex-render.test.cjs
const { app, BrowserWindow } = require("electron");
const { build } = require("esbuild");
const { mkdtemp, readFile, writeFile, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const assert = require("node:assert/strict");
const { writeFileSync, appendFileSync } = require("node:fs");
const statusPath = path.join(__dirname, "codex-render-status.json");
const status = (value) => writeFileSync(statusPath, JSON.stringify(value, null, 2));

app.whenReady().then(async () => {
  const deadline = setTimeout(() => { status({ passed: false, error: "Renderer startup timed out after 60 seconds" }); app.exit(1); }, 60000);
  const dir = await mkdtemp(path.join(tmpdir(), "crashvzn-render-"));
  let win;
  let exitCode = 0;
  try {
    status({ stage: "bundling" });
    const root = path.resolve(__dirname, "..");
    const result = JSON.parse(await readFile(path.join(__dirname, "codex-vision-live-result.json"), "utf8"));
    const js = await build({
      stdin: { contents: `
        import { buildIncidentScene } from "./src/incident/engine";
        import { mountScene } from "./src/scene/mountScene";
        (async () => {
          console.log("smoke: engine");
          const built = buildIncidentScene({id: "codex-render-smoke", spec: ${JSON.stringify(result.spec)}, seed: 42, created: "2026-11-15"});
          console.log("smoke: mounting viewer");
          const viewer = await mountScene(document.getElementById("view"), () => {});
          console.log("smoke: loading scene");
          viewer.showProxy(built.layout.id, built.scene.vehicles, built.scene.environment, built.scene.duration);
          await new Promise(resolve => setTimeout(resolve, 2000));
          console.log("smoke: rendering");
          viewer.setTime(22);
          viewer.resize();
          viewer.render();
          const poses = built.scene.vehicles.map(v => viewer.vehiclePose(v.id, 22));
          window.__smoke = {vehicles: poses.length, finite: poses.every(p => p && [...p.position, p.yaw].every(Number.isFinite)), canvas: !!document.querySelector("canvas")};
        })().catch(error => { window.__smoke = {error: error.stack || String(error)}; });
      `, resolveDir: root, loader: "ts" },
      tsconfig: path.join(root, "tsconfig.json"), bundle: true, format: "iife", platform: "browser", write: false, logLevel: "silent",
      define: { "import.meta.env.BASE_URL": JSON.stringify(pathToFileURL(path.join(root, "public") + path.sep).href) },
    });
    await writeFile(path.join(dir, "scene.js"), js.outputFiles[0].contents);
    await writeFile(path.join(dir, "index.html"), '<html><body style="margin:0;overflow:hidden"><div id="view" style="width:100vw;height:100vh"></div><script>window.onerror = message => window.__smoke = {error: String(message)};</script><script src="scene.js"></script></body></html>');
    win = new BrowserWindow({ show: false, width: 1280, height: 720, webPreferences: { backgroundThrottling: false } });
    win.webContents.on("console-message", (_event, details, message) => appendFileSync(path.join(__dirname, "codex-render-console.log"), `${details?.message ?? message}\n`));
    status({ stage: "loading" });
    await win.loadFile(path.join(dir, "index.html"));
    status({ stage: "loaded" });
    const state = await win.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const started = Date.now();
      const timer = setInterval(() => {
        if (window.__smoke) { clearInterval(timer); resolve(window.__smoke); }
        else if (Date.now() - started > 45000) { clearInterval(timer); reject(new Error("Renderer test timed out")); }
      }, 100);
    })`);
    status(state);
    assert.ok(!state.error, state.error);
    assert.ok(state.vehicles > 0 && state.finite && state.canvas, JSON.stringify(state));
    const screenshot = await win.webContents.capturePage();
    assert.ok(!screenshot.isEmpty());
    const imagePath = path.join(__dirname, "codex-render-live.png");
    await writeFile(imagePath, screenshot.toPNG());
    console.log(`Real viewer rendering passed: ${state.vehicles} vehicles. Screenshot: ${imagePath}`);
    status({ ...state, screenshot: imagePath, passed: true });
  } catch (error) {
    console.error(error);
    status({ passed: false, error: error.stack || String(error) });
    exitCode = 1;
  } finally {
    clearTimeout(deadline);
    win?.destroy();
    await rm(dir, { recursive: true, force: true });
    app.exit(exitCode);
  }
});
