// Runs inside the hidden Electron window (bundled by compare.cjs). Real engine + real viewer.
import * as THREE from "three";
import { buildIncidentScene } from "../../../src/incident/engine";
import { mountScene } from "../../../src/scene/mountScene";
import { sourceCamera, calibProject, worldToScene, CX, CY, TILE_W, TILE_H, type Calib } from "./source-camera";

declare const __SPEC__: any;
declare const __CALIB__: Calib;
declare const __CRASH_PAIR__: any;
declare const __SCALE__: number;
declare const __VAN_IMG__: [number, number][];

const W: any = window;
const S = __SCALE__;
const RW = TILE_W * S, RH = TILE_H * S;
const raf = () => new Promise((r) => requestAnimationFrame(() => r(null)));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const loadImage = (src: string) => new Promise<HTMLImageElement>((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });

/** Mirror of the viewer camera (PerspectiveCamera(fov, aspect) looking at target, world up) + image roll. */
function makeProjector(cam: ReturnType<typeof sourceCamera>) {
  const c = new THREE.PerspectiveCamera(cam.fovDeg, TILE_W / TILE_H, 0.1, 3000);
  c.position.set(...cam.position);
  c.lookAt(new THREE.Vector3(...cam.target));
  c.updateMatrixWorld(true);
  const cr = Math.cos(cam.roll), sr = Math.sin(cam.roll);
  // Returns tile pixels in cam.py's convention (pixel centre = integer; principal point 239.5,150).
  return (p: [number, number, number]): [number, number] | null => {
    const v = new THREE.Vector3(...p).applyMatrix4(c.matrixWorldInverse);
    if (v.z > -0.1) return null;
    v.applyMatrix4(c.projectionMatrix);
    const x = (v.x + 1) / 2 * TILE_W - TILE_W / 2, y = (1 - v.y) / 2 * TILE_H - TILE_H / 2; // relative to image centre
    return [CX + cr * x - sr * y, CY + sr * x + cr * y];
  };
}

function gray(img: CanvasImageSource, w: number, h: number) {
  const cv = document.createElement("canvas"); cv.width = w; cv.height = h;
  const ctx = cv.getContext("2d")!; ctx.drawImage(img, 0, 0, w, h);
  const d = ctx.getImageData(0, 0, w, h).data;
  const g = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) g[i] = 0.299 * d[4 * i] + 0.587 * d[4 * i + 1] + 0.114 * d[4 * i + 2];
  return { g, w, h };
}

/** Brightest thin line (white-top-hat along the row) within +-r px of u at row v; subpixel. */
function linePeak(im: { g: Float32Array; w: number; h: number }, u: number, v: number, r = 5) {
  const row = Math.round(v);
  if (row < 2 || row >= im.h - 2) return null;
  const at = (x: number) => im.g[row * im.w + Math.max(0, Math.min(im.w - 1, x))];
  const th = (x: number) => { let s = 0; for (let k = -6; k <= 6; k++) s += at(x + k); return at(x) - s / 13; };
  let best = -1e9, bx = -1;
  for (let x = Math.round(u - r); x <= Math.round(u + r); x++) { if (x < 7 || x >= im.w - 7) continue; const t = th(x); if (t > best) { best = t; bx = x; } }
  if (bx < 0 || best < 8) return null;
  const a = th(bx - 1), b = th(bx), c = th(bx + 1);
  const den = a - 2 * b + c;
  return bx + (Math.abs(den) > 1e-6 ? 0.5 * (a - c) / den : 0);
}
const median = (a: number[]) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const r2 = (x: number | null) => (x == null ? null : Math.round(x * 100) / 100);

(async () => {
  const spec = __SPEC__.spec ?? __SPEC__;
  const cal = __CALIB__;
  const cam = sourceCamera(cal);
  const project = makeProjector(cam);
  const built = buildIncidentScene({ id: "demo-fit", spec, seed: 42, created: "2026-11-15" });
  const view = document.getElementById("view")!;
  view.style.width = RW + "px"; view.style.height = RH + "px";
  const viewer = await mountScene(view, () => {});
  viewer.showProxy(built.layout.id, built.scene.vehicles, built.scene.environment, built.scene.duration);
  viewer.setLayers({ trails: false, bounds: false, hitboxes: false, hiddenVehicles: [] });
  let grabbed: string | null = null, grab = false;
  viewer.onFrame((canvas) => { if (grab) { grabbed = canvas.toDataURL("image/png"); grab = false; } });
  const placed = viewer.setCamera({ position: cam.position, target: cam.target }, { instant: true, fovDeg: cam.fovDeg });
  viewer.resize();
  // Let textures / HDR sky load.
  for (let i = 0; i < 10; i++) { viewer.render(); await raf(); }
  await sleep(3000);
  const ids = built.scene.vehicles.map((v) => v.id);
  const specById = Object.fromEntries(spec.objects.map((o: any) => [o.id, o]));

  // ---- validation: calibration-only (camera conversion) ----
  const vp = __CRASH_PAIR__.vehicles["white-van"];
  const s0 = vp.samples.find((s: any) => s.f === 0) ?? vp.samples[0];
  const vanYaw = (s0.heading_deg - 180) * Math.PI / 180;
  const KEYS = [[-1, -1, 0], [-1, 1, 0], [1, -1, 0], [1, 1, 0], [-1, -1, 1], [-1, 1, 1], [1, -1, 1], [1, 1, 1]];
  const vanCorners = (X: number, Y: number, yaw: number, L: number, Wd: number, H: number) => KEYS.map(([fr, lr, tb]) => {
    const dx = fr * L / 2, dy = lr * Wd / 2, c = Math.cos(yaw), s = Math.sin(yaw);
    return [X + c * dx - s * dy, Y + s * dx + c * dy, tb * H] as [number, number, number];
  });
  const corners = vanCorners(s0.x, s0.y, vanYaw, vp.length_m, vp.width_m, vp.height_m);
  const vanErr = corners.map((p, i) => {
    const q = project(worldToScene(...p))!; const k = calibProject(cal, ...p); const real = __VAN_IMG__[i];
    return { real, three: q.map(r2), calib: k.map(r2), errVsReal: r2(Math.hypot(q[0] - real[0], q[1] - real[1])), errVsCalib: r2(Math.hypot(q[0] - k[0], q[1] - k[1])) };
  });

  // Lane lines: three-projection vs cam.py, and vs the real (vehicle-free) background frame + the render.
  const bgImg = await loadImage(W.__BG__);
  const bg = gray(bgImg, TILE_W, TILE_H);
  const linePts = (name: string) => {
    const Y = cal.lines[name];
    const rng = cal.report?.lines?.[name]?.X_seen ?? [60, 300];
    const pts: { X: number; u: number; v: number; k: [number, number] }[] = [];
    for (let X = rng[0]; X <= rng[1]; X += (X < 120 ? 2 : 5)) {
      const q = project(worldToScene(X, Y)); if (!q) continue;
      if (q[0] < 8 || q[0] > TILE_W - 8 || q[1] < 4 || q[1] > TILE_H - 4) continue;
      pts.push({ X, u: q[0], v: q[1], k: calibProject(cal, X, Y) });
    }
    return pts;
  };
  const measureLines = (im: ReturnType<typeof gray>) => Object.fromEntries(Object.keys(cal.lines).map((name) => {
    const pts = linePts(name);
    const du: number[] = [];
    for (const p of pts) { const pk = linePeak(im, p.u, p.v); if (pk != null) du.push(pk - p.u); }
    return [name, { n: pts.length, found: du.length, medianDu_px: r2(median(du)), medianAbsDu_px: r2(median(du.map(Math.abs))) }];
  }));
  const lineVsCalib = Object.fromEntries(Object.keys(cal.lines).map((name) => {
    const pts = linePts(name); return [name, r2(Math.max(0, ...pts.map((p) => Math.hypot(p.u - p.k[0], p.v - p.k[1]))))];
  }));

  // Render one frame; returns PNG data URL at RW x RH (no roll applied).
  const renderAt = async (t: number) => {
    viewer.setTime(t);
    viewer.setCamera({ position: cam.position, target: cam.target }, { instant: true, fovDeg: cam.fovDeg });
    for (let i = 0; i < 3; i++) { viewer.render(); await raf(); }
    grab = true; viewer.render();
    const url = grabbed!; grabbed = null;
    return url;
  };

  // Scene geometry check on the rendered road at t=0 (lane paint in the render vs calibration).
  const r0 = await loadImage(await renderAt(0));
  const rolled0 = rollCanvas(r0);
  const renderLines = measureLines(gray(rolled0, TILE_W, TILE_H));
  const realLines = measureLines(bg);

  const vanScene = viewer.vehiclePose("white-van", 0);
  const vanExpected = worldToScene(s0.x, s0.y);
  W.__info = {
    camera: cam, placed, vehicles: ids.length, duration: built.scene.duration, impactTime: built.scene.impactTime,
    removed: built.report.removed,
    validation: {
      vanBox: { corners: vanErr, rmsVsReal_px: r2(Math.sqrt(vanErr.reduce((s, e) => s + e.errVsReal! ** 2, 0) / 8)), maxVsCalib_px: r2(Math.max(...vanErr.map((e) => e.errVsCalib!))) },
      laneLinesMaxVsCalib_px: lineVsCalib,
      laneLinesRealBg: realLines,
      laneLinesRender_t0: renderLines,
      vanScenePose_t0: { viewer: vanScene, expectedFromCrashPair: vanExpected, err_m: vanScene ? r2(Math.hypot(vanScene.position[0] - vanExpected[0], vanScene.position[2] - vanExpected[2])) : null },
    },
  };

  function rollCanvas(img: CanvasImageSource, w = TILE_W * S, h = TILE_H * S) {
    const cv = document.createElement("canvas"); cv.width = w; cv.height = h;
    const ctx = cv.getContext("2d")!;
    ctx.fillStyle = "#000"; ctx.fillRect(0, 0, w, h);
    ctx.translate(w / 2, h / 2); ctx.rotate(cam.roll); ctx.drawImage(img, -w / 2, -h / 2, w, h);
    return cv;
  }

  // Compose one sheet: real | render / blend | annotated render.
  W.__sheet = async (frame: number, realUrl: string, specLabel: string) => {
    const t = frame / 12.5;
    const render = rollCanvas(await loadImage(await renderAt(t)));
    const real = await loadImage(realUrl);
    const PW = TILE_W * S, PH = TILE_H * S, HD = 26 * S, GAP = 4;
    const cv = document.createElement("canvas"); cv.width = 2 * PW + GAP; cv.height = HD + 2 * (PH + 18 * S) + GAP;
    const ctx = cv.getContext("2d")!;
    ctx.fillStyle = "#111"; ctx.fillRect(0, 0, cv.width, cv.height);
    ctx.fillStyle = "#fff"; ctx.font = `bold ${15 * S}px sans-serif`; ctx.textBaseline = "middle";
    ctx.fillText(`frame ${frame}   t = ${t.toFixed(2)} s   ${specLabel}`, 8, HD / 2);
    const panel = (i: number, title: string, draw: (c: CanvasRenderingContext2D) => void) => {
      const x = (i % 2) * (PW + GAP), y = HD + Math.floor(i / 2) * (PH + 18 * S + GAP);
      ctx.fillStyle = "#ccc"; ctx.font = `${12 * S}px sans-serif`; ctx.fillText(title, x + 4, y + 9 * S);
      ctx.save(); ctx.translate(x, y + 18 * S); ctx.beginPath(); ctx.rect(0, 0, PW, PH); ctx.clip(); draw(ctx); ctx.restore();
    };
    panel(0, "REAL (demo.mp4 crop 479x300+481+304)", (c) => c.drawImage(real, 0, 0, PW, PH));
    panel(1, "RENDER (engine + mountScene, source camera)", (c) => c.drawImage(render, 0, 0));
    panel(2, "50% BLEND", (c) => { c.drawImage(real, 0, 0, PW, PH); c.globalAlpha = 0.5; c.drawImage(render, 0, 0); c.globalAlpha = 1; });
    const labels: any[] = [];
    panel(3, "RENDER + calib lane lines (cyan) + vehicle ids (yellow = crash)", (c) => {
      c.drawImage(render, 0, 0);
      c.strokeStyle = "rgba(0,255,255,0.8)"; c.lineWidth = 1;
      for (const name of Object.keys(cal.lines)) {
        const pts = linePts(name); if (pts.length < 2) continue;
        c.beginPath(); pts.forEach((p, j) => (j ? c.lineTo(p.u * S, p.v * S) : c.moveTo(p.u * S, p.v * S))); c.stroke();
      }
      c.font = `${10 * S}px sans-serif`;
      for (const id of ids) {
        const p = viewer.vehiclePose(id, t);
        if (!p || p.hidden) continue;
        const q = project([p.position[0], 0, p.position[2]]);
        if (!q || q[0] < -20 || q[0] > TILE_W + 20 || q[1] < -20 || q[1] > TILE_H + 20) continue;
        const crash = built.scene.crashVehicles.includes(id);
        labels.push({ id, u: r2(q[0]), v: r2(q[1]), plan: [r2(p.position[0]), r2(-p.position[2])], yawDeg: r2(p.yaw * 180 / Math.PI), category: specById[id]?.category });
        c.fillStyle = crash ? "#ff0" : "#f6f"; c.fillRect(q[0] * S - 1.5, q[1] * S - 1.5, 3, 3);
        c.fillText(id, q[0] * S + 3, q[1] * S - 3);
      }
    });
    return { sheet: cv.toDataURL("image/png"), blend: (() => {
      const b = document.createElement("canvas"); b.width = PW; b.height = PH; const bc = b.getContext("2d")!;
      bc.drawImage(real, 0, 0, PW, PH); bc.globalAlpha = 0.5; bc.drawImage(render, 0, 0); return b.toDataURL("image/png");
    })(), render: render.toDataURL("image/png"), vehiclesInView: labels };
  };

  // Contact sheet from already-written per-frame images.
  W.__contact = async (items: { frame: number; real: string; render: string; blend: string }[]) => {
    const TW = 320, TH = Math.round(320 * TILE_H / TILE_W), LB = 16, COLS = 2;
    const rowW = 3 * TW + 8, rows = Math.ceil(items.length / COLS);
    const cv = document.createElement("canvas"); cv.width = COLS * rowW + (COLS - 1) * 12; cv.height = rows * (TH + LB + 6);
    const ctx = cv.getContext("2d")!; ctx.fillStyle = "#111"; ctx.fillRect(0, 0, cv.width, cv.height);
    ctx.font = "bold 12px sans-serif"; ctx.textBaseline = "middle";
    for (let i = 0; i < items.length; i++) {
      const it = items[i], x0 = (i % COLS) * (rowW + 12), y0 = Math.floor(i / COLS) * (TH + LB + 6);
      ctx.fillStyle = "#fff"; ctx.fillText(`f${it.frame}  t=${(it.frame / 12.5).toFixed(2)}s   real | render | blend`, x0 + 4, y0 + LB / 2);
      const imgs = await Promise.all([it.real, it.render, it.blend].map(loadImage));
      imgs.forEach((im, j) => ctx.drawImage(im, x0 + j * (TW + 4), y0 + LB, TW, TH));
    }
    return cv.toDataURL("image/png");
  };
  W.__ready = true;
})().catch((e) => { W.__error = String(e?.stack || e); W.__ready = true; });
