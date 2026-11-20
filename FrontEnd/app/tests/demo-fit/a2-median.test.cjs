// A2: renders the demo spec's road + median (verge, barrier, hedge) through the real engine and viewer
// in a hidden Electron window, from the calibrated crash camera (measure/cam.py) and from close-ups.
// Run: FrontEnd/app/node_modules/electron/dist/electron.exe FrontEnd/app/tests/demo-fit/a2-median.test.cjs
// Writes PNGs + status.json to tests/demo-fit/a2/.
const { app, BrowserWindow } = require("electron");
const { build } = require("esbuild");
const { mkdtemp, readFile, writeFile, rm, mkdir } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const root = path.resolve(__dirname, "..", "..");
const out = path.join(__dirname, "a2");
const specPath = path.join(root, "electron", "demo-incident", "incident-spec.json");
// Video frames (12.5 fps) to compare with tests/demo-fit/iter1/real/fNNN.png.
const FRAMES = [0, 213, 270, 288, 300];
// Crash camera in the scene frame (cam.py: f=2029 px on a 300 px tall tile; X_REF = 95.06, Y_median = -4.803).
const CAM = { position: [95.06, 8.616, -2.721], target: [-11.17, 0, 0.977] };
const FOV = (2 * Math.atan(150 / 2029.35) * 180) / Math.PI;

app.on("window-all-closed", () => {});
app.whenReady().then(async () => {
  const deadline = setTimeout(() => app.exit(1), 120000);
  await mkdir(out, { recursive: true });
  const dir = await mkdtemp(path.join(tmpdir(), "a2-median-"));
  let win;
  let code = 0;
  const errors = [];
  try {
    let spec = JSON.parse(await readFile(specPath, "utf8"));
    if (spec.spec && spec.spec.objects) spec = spec.spec;
    const js = await build({
      stdin: { contents: `
        import { buildIncidentScene } from "./src/incident/engine";
        import { mountScene } from "./src/scene/mountScene";
        (async () => {
          const built = buildIncidentScene({ id: "a2-median", spec: ${JSON.stringify(spec)}, seed: 42, created: "2026-11-15" });
          const viewer = await mountScene(document.getElementById("view"), () => {});
          viewer.showProxy(built.layout.id, built.scene.vehicles, built.scene.environment, built.scene.duration);
          await new Promise((r) => setTimeout(r, 2500));
          window.__frame = async (t, pose, fovDeg) => {
            viewer.setTime(t);
            const cam = viewer.setCamera(pose, { instant: true, fovDeg });
            viewer.resize();
            for (let i = 0; i < 3; i++) { viewer.render(); await new Promise((r) => requestAnimationFrame(r)); }
            return cam;
          };
          window.__info = { vehicles: built.scene.vehicles.length, site: built.layout.site };
          window.__ready = true;
        })().catch((e) => { window.__info = { error: e.stack || String(e) }; window.__ready = true; });
      `, resolveDir: root, loader: "ts" },
      tsconfig: path.join(root, "tsconfig.json"), bundle: true, format: "iife", platform: "browser", write: false, logLevel: "silent",
      define: { "import.meta.env.BASE_URL": JSON.stringify(pathToFileURL(path.join(root, "public") + path.sep).href) },
    });
    await writeFile(path.join(dir, "scene.js"), js.outputFiles[0].contents);
    await writeFile(path.join(dir, "index.html"), '<html><body style="margin:0;overflow:hidden"><div id="view" style="width:100vw;height:100vh"></div><script src="scene.js"></script></body></html>');
    // Same aspect as the 479x300 video tile.
    win = new BrowserWindow({ show: false, width: 958, height: 600, webPreferences: { backgroundThrottling: false } });
    win.webContents.on("console-message", (_e, d, m) => {
      const level = typeof d === "object" ? d.level : d;
      if (level === "error" || level === 3) errors.push(String(d?.message ?? m));
    });
    await win.loadFile(path.join(dir, "index.html"));
    await win.webContents.executeJavaScript(`new Promise((res) => { const t = setInterval(() => { if (window.__ready) { clearInterval(t); res(); } }, 100); })`);
    const info = await win.webContents.executeJavaScript("window.__info");
    if (info.error) throw new Error(info.error);
    const shots = [];
    const shoot = async (name, t, pose, fov) => {
      const cam = await win.webContents.executeJavaScript(`window.__frame(${t}, ${JSON.stringify(pose)}, ${fov ?? "undefined"})`);
      const image = await win.webContents.capturePage();
      await writeFile(path.join(out, name), image.toPNG());
      shots.push({ name, t, cam });
    };
    for (const f of FRAMES) await shoot(`cam-f${String(f).padStart(3, "0")}.png`, f / 12.5, CAM, FOV);
    // Close-ups of the median at the crash site and at the verge's far end (x = -63.8, where the hedge starts).
    await shoot("close-crash.png", 21.6, { position: [40, 7, -14], target: [12, 0, 3] }, 40);
    await shoot("close-verge-end.png", 15, { position: [-40, 9, -16], target: [-66, 0, 2] }, 40);
    await shoot("top-crash.png", 21.6, { position: [10, 60, 4], target: [10, 0, 3.5] }, 40);
    await writeFile(path.join(out, "status.json"), JSON.stringify({ info, fov: FOV, shots, errors }, null, 2));
    console.log(`a2 render: ${shots.length} shots, ${errors.length} console errors`);
  } catch (error) {
    console.error(error);
    await writeFile(path.join(out, "status.json"), JSON.stringify({ error: error.stack || String(error), errors }, null, 2));
    code = 1;
  } finally {
    clearTimeout(deadline);
    win?.destroy();
    await rm(dir, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
    app.exit(code);
  }
});
