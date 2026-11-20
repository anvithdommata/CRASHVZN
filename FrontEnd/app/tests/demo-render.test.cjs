// Renders the demo crash through the real engine + viewer in a hidden Electron window.
// Run: FrontEnd/app/node_modules/electron/dist/electron.exe FrontEnd/app/tests/demo-render.test.cjs
// Uses electron/demo-incident/incident-spec.json when it exists, otherwise a small temporary spec
// (tests/tmp-demo-spec.json, deleted afterwards). Writes demo-*.png and demo-render-status.json here.
const { app, BrowserWindow } = require("electron");
const { build } = require("esbuild");
const { mkdtemp, readFile, writeFile, rm } = require("node:fs/promises");
const { existsSync, writeFileSync, appendFileSync, unlinkSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const root = path.resolve(__dirname, "..");
const realSpecPath = path.join(root, "electron", "demo-incident", "incident-spec.json");
const tmpSpecPath = path.join(__dirname, "tmp-demo-spec.json");
const statusPath = path.join(__dirname, "demo-render-status.json");
const consolePath = path.join(__dirname, "demo-render-console.log");
const status = (value) => writeFileSync(statusPath, JSON.stringify(value, null, 2));
const TIMES = [15, 21.5, 22.4, 24, 30];

/** Stand-in until the hand-verified spec lands: stopped van in forward lane 1, yellow car rear-ends it at 22.3 s, some traffic. */
function tempSpec() {
  const kf = (t_s, x_m, y_m, heading_deg, speed_mps) => ({ t_s, x_m, y_m, heading_deg, speed_mps });
  const obj = (id, label, category, color_name, color_hex, involvement, length_m, mass_kg, keyframes, rest = null) => ({
    id, label, category, color_name, color_hex, make: null, model: null, involvement, length_m, width_m: category === "van" ? 2.0 : 1.8, mass_kg,
    visible_from_s: keyframes[0].t_s, visible_to_s: keyframes.at(-1).t_s, keyframes, forces: [], rest, confidence: 0.9,
  });
  const LANE = [-2.925, -6.575, -10.225];
  const objects = [
    obj("white-van", "White van", "van", "white", "#F2F2F2", "crash", 5.2, 2400,
      [kf(0, 15, LANE[0], 0, 0), kf(22.3, 15, LANE[0], 0, 0), kf(23.2, 18.5, LANE[0], 2, 1.5), kf(24, 19, LANE[0], 2, 0), kf(60, 19, LANE[0], 2, 0)],
      { x_m: 19, y_m: LANE[0], heading_deg: 2 }),
    obj("yellow-car", "Yellow car", "sedan", "yellow", "#F2C200", "crash", 4.6, 1400,
      [kf(17, -95.9, LANE[0], 0, 20), kf(20, -35.9, LANE[0], 0, 20), kf(22.3, 10.1, LANE[0], 0, 20), kf(23.2, 12.5, LANE[0], -8, 1), kf(24, 12.6, LANE[0], -8, 0), kf(60, 12.6, LANE[0], -8, 0)],
      { x_m: 12.6, y_m: LANE[0], heading_deg: -8 }),
  ];
  const colors = [["silver", "#B8BCC2"], ["blue", "#2A5BD7"], ["red", "#C0262D"], ["black", "#1E1E22"], ["green", "#2E7D4F"]];
  let n = 0;
  // Forward lane 2: enters at x=-150, leaves at +150 (slows past the crash after it happens).
  for (const start of [2, 9, 16, 23, 30, 37]) {
    const speed = start >= 20 ? 12 : 25;
    const [cn, hex] = colors[n % colors.length];
    objects.push(obj(`bg-${++n}`, `${cn} sedan ${n}`, "sedan", cn, hex, "background", 4.5, 1500,
      [kf(start, -150, LANE[1], 0, speed), kf(start + 300 / speed, 150, LANE[1], 0, speed)]));
  }
  // Oncoming carriageway.
  for (const start of [4, 12, 20, 28]) {
    const [cn, hex] = colors[n % colors.length];
    objects.push(obj(`bg-${++n}`, `${cn} suv ${n}`, "suv", cn, hex, "background", 4.8, 1900,
      [kf(start, 150, -LANE[1], 180, 25), kf(start + 12, -150, -LANE[1], 180, 25)]));
  }
  return {
    prompt_version: "codex-scene-v6", title: "Temporary demo spec", location_guess: "Test highway", summary: "Yellow car rear-ends a stopped van.",
    duration_s: 60,
    views: [{ video_index: 1, description: "test", camera_kind: "fixed roadside camera", moving: false, time_offset_s: 0, plus_x_traffic: "toward_camera" }],
    environment_preset: "clear_winter",
    road: { kind: "divided_highway", region: "US", road_class: "motorway", lanes_each_way: 3, cross_lanes_each_way: 1, surface: "dry", grade_percent: 0, speed_limit_mps: null },
    wind: { toward_deg: 0, speed_mps: 0 },
    crash: { start_s: 22.3, end_s: 24, kind: "rear_end", description: "Yellow car hits the stopped van.", participants: ["yellow-car", "white-van"],
      contacts: [{ a: "yellow-car", b: "white-van", t_s: 22.3, x_m: 12.4, y_m: -2.925, normal_deg: 0 }] },
    objects,
    caveats: [],
  };
}

// Don't let destroying the window quit before cleanup runs.
app.on("window-all-closed", () => {});

app.whenReady().then(async () => {
  const deadline = setTimeout(() => { status({ passed: false, error: "Timed out after 100 seconds" }); app.exit(1); }, 100000);
  const dir = await mkdtemp(path.join(tmpdir(), "demo-render-"));
  writeFileSync(consolePath, "");
  let win;
  let exitCode = 0;
  const usingReal = existsSync(realSpecPath);
  const consoleErrors = [];
  try {
    status({ stage: "bundling" });
    let spec;
    if (usingReal) spec = JSON.parse(await readFile(realSpecPath, "utf8"));
    else {
      spec = tempSpec();
      await writeFile(tmpSpecPath, JSON.stringify(spec, null, 2));
    }
    // The real spec may be wrapped ({ spec: ... }).
    if (spec && spec.spec && spec.spec.objects) spec = spec.spec;
    const js = await build({
      stdin: { contents: `
        import { buildIncidentScene } from "./src/incident/engine";
        import { mountScene } from "./src/scene/mountScene";
        import { deriveSceneKinematics } from "./src/kinematics/derive";
        (async () => {
          const built = buildIncidentScene({ id: "demo-render", spec: ${JSON.stringify(spec)}, seed: 42, created: "2026-11-15" });
          const viewer = await mountScene(document.getElementById("view"), () => {});
          viewer.showProxy(built.layout.id, built.scene.vehicles, built.scene.environment, built.scene.duration);
          await new Promise((resolve) => setTimeout(resolve, 2500));
          const ids = built.scene.vehicles.map((v) => v.id);
          const at = (t) => {
            const poses = ids.map((id) => [id, viewer.vehiclePose(id, t)]);
            return {
              t,
              visible: poses.filter(([, p]) => p && !p.hidden).length,
              hidden: poses.filter(([, p]) => p && p.hidden).length,
              finite: poses.every(([, p]) => p && [...p.position, p.yaw].every(Number.isFinite)),
              crash: Object.fromEntries(built.scene.crashVehicles.map((id) => { const p = viewer.vehiclePose(id, t); return [id, p && { x: +p.position[0].toFixed(2), z: +p.position[2].toFixed(2), yawDeg: +(p.yaw * 180 / Math.PI).toFixed(1), hidden: !!p.hidden }]; })),
            };
          };
          // Kinematics as stored in MongoDB: no frames while hidden, no speed spikes at entry/exit.
          const kin = deriveSceneKinematics(built.scene);
          const maxSpeed = kin ? Math.max(...kin.frames.map((f) => f.speed)) : null;
          const crashPoint = built.layout.camera.target;
          // Traffic near the crash, per lane (kinematics frame: origin at the crash, z = across the road),
          // before vs after impact; and how much each crash vehicle moved before impact.
          const impact = built.scene.impactTime ?? 22.3;
          const lanes = {};
          for (const f of kin ? kin.frames : []) {
            if (built.scene.crashVehicles.includes(f.entity_id) || Math.abs(f.position[0]) > 80) continue;
            const key = (f.velocity[0] >= 0 ? "with" : "against") + " z~" + (Math.round(f.position[2] / 1.825) * 1.825).toFixed(1);
            const phase = f.t < impact - 0.1 ? (f.t >= impact - 8 ? "before" : null) : f.t > impact + 1 && f.t <= impact + 15 ? "after" : null;
            if (!phase) continue;
            const l = (lanes[key] ??= { before: [0, 0], after: [0, 0], ids: new Set() });
            l[phase][0] += f.speed; l[phase][1]++; l.ids.add(f.entity_id);
          }
          const laneSpeeds = Object.fromEntries(Object.entries(lanes).map(([k, l]) => [k, {
            vehicles: l.ids.size,
            meanSpeedBefore_mps: l.before[1] ? +(l.before[0] / l.before[1]).toFixed(2) : null,
            meanSpeedAfter_mps: l.after[1] ? +(l.after[0] / l.after[1]).toFixed(2) : null,
          }]));
          const crashMotion = Object.fromEntries(built.scene.crashVehicles.map((id) => {
            const fr = (kin ? kin.frames : []).filter((f) => f.entity_id === id);
            const pre = fr.filter((f) => f.t < impact - 0.05);
            return [id, {
              visibleFrom: fr[0]?.t ?? null, visibleTo: fr.at(-1)?.t ?? null,
              maxSpeedBeforeImpact_mps: pre.length ? +Math.max(...pre.map((f) => f.speed)).toFixed(2) : null,
              speedAtImpact_mps: +(fr.find((f) => f.t >= impact - 0.05)?.speed ?? NaN).toFixed(2),
              speedAt24_mps: +(fr.find((f) => f.t >= 24)?.speed ?? NaN).toFixed(2),
            }];
          }));
          window.__demo = {
            vehicles: ids.length,
            impactTime: built.scene.impactTime,
            crashEnd: built.scene.crashEnd,
            crashVehicles: built.scene.crashVehicles,
            startTime: built.scene.startTime,
            crashPoint,
            removed: built.report.removed,
            notes: built.report.notes,
            kinematics: kin && { frames: kin.frames.length, fullFrames: ids.length * (Math.floor(built.scene.duration * 30 + 1e-6) + 1), maxSpeed_mps: maxSpeed },
            laneSpeeds,
            crashMotion,
            times: [${[0, ...TIMES].join(",")}].map(at),
          };
          const crash = built.scene.crashVehicles.map((id) => viewer.vehiclePose(id, built.scene.impactTime ?? 22.3)).filter(Boolean);
          const cx = crash.length ? crash.reduce((s, p) => s + p.position[0], 0) / crash.length : crashPoint[0];
          const cz = crash.length ? crash.reduce((s, p) => s + p.position[2], 0) / crash.length : crashPoint[2];
          window.__frame = async (t, wide) => {
            viewer.setTime(t);
            const camera = wide
              ? viewer.setCamera({ position: [cx - 20, 170, cz + 150], target: [cx, 0, cz] }, { instant: true })
              : viewer.setCamera({ position: [cx - 42, 20, cz + 26], target: [cx - 4, 0, cz] }, { instant: true });
            viewer.resize();
            for (let i = 0; i < 3; i++) { viewer.render(); await new Promise((r) => requestAnimationFrame(r)); }
            return camera;
          };
          window.__ready = true;
        })().catch((error) => { window.__demo = { error: error.stack || String(error) }; window.__ready = true; });
      `, resolveDir: root, loader: "ts" },
      tsconfig: path.join(root, "tsconfig.json"), bundle: true, format: "iife", platform: "browser", write: false, logLevel: "silent",
      // Vite normally provides this; the viewer loads textures/HDRs relative to it.
      define: { "import.meta.env.BASE_URL": JSON.stringify(pathToFileURL(path.join(root, "public") + path.sep).href) },
    });
    await writeFile(path.join(dir, "scene.js"), js.outputFiles[0].contents);
    await writeFile(path.join(dir, "index.html"), '<html><body style="margin:0;overflow:hidden"><div id="view" style="width:100vw;height:100vh"></div><script>window.onerror = (m) => { window.__demo = {error: String(m)}; window.__ready = true; };</script><script src="scene.js"></script></body></html>');
    win = new BrowserWindow({ show: false, width: 1280, height: 720, webPreferences: { backgroundThrottling: false } });
    win.webContents.on("console-message", (_event, details, message) => {
      const level = typeof details === "object" ? details.level : details;
      const text = details?.message ?? message;
      appendFileSync(consolePath, `[${level}] ${text}\n`);
      if (level === "error" || level === 3) consoleErrors.push(String(text));
    });
    status({ stage: "loading" });
    await win.loadFile(path.join(dir, "index.html"));
    await win.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const started = Date.now();
      const timer = setInterval(() => {
        if (window.__ready) { clearInterval(timer); resolve(true); }
        else if (Date.now() - started > 60000) { clearInterval(timer); reject(new Error("Renderer test timed out")); }
      }, 100);
    })`);
    const state = await win.webContents.executeJavaScript("window.__demo");
    if (state.error) throw new Error(state.error);
    const shots = [];
    const shoot = async (t, wide, name) => {
      const camera = await win.webContents.executeJavaScript(`window.__frame(${t}, ${wide})`);
      const image = await win.webContents.capturePage();
      if (image.isEmpty()) throw new Error(`Empty capture at ${t}s`);
      const file = path.join(__dirname, name);
      await writeFile(file, image.toPNG());
      shots.push({ t, wide, file, camera });
    };
    await shoot(15, true, "demo-overview-15.png");
    for (const t of TIMES) await shoot(t, false, `demo-crash-${String(t).replace(".", "_")}.png`);
    const finite = state.times.every((s) => s.finite);
    const passed = finite && state.vehicles > 0 && consoleErrors.length === 0;
    status({ passed, spec: usingReal ? realSpecPath : "temporary (tests/tmp-demo-spec.json, deleted)", ...state, finite, shots, consoleErrors });
    console.log(`demo render ${passed ? "passed" : "FAILED"}: ${state.vehicles} vehicles, ${shots.length} frames`);
    if (!passed) exitCode = 1;
  } catch (error) {
    console.error(error);
    status({ passed: false, spec: usingReal ? realSpecPath : "temporary", error: error.stack || String(error), consoleErrors });
    exitCode = 1;
  } finally {
    clearTimeout(deadline);
    win?.destroy();
    try { if (!usingReal && existsSync(tmpSpecPath)) unlinkSync(tmpSpecPath); } catch {}
    await rm(dir, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
    app.exit(exitCode);
  }
});
