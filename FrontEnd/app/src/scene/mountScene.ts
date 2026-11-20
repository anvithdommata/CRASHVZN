import { driveVehicle, makeVehicle, type VehicleKind, type VehicleRig } from "@/scene/cars";
import { Painter } from "@/scene/draw";
import {
  applyWorldUVs,
  buildSurroundings,
  createSurfaces,
  DEFAULT_ENVIRONMENT,
  environmentKey,
  loadSky,
  releaseSky,
  resolveEnvironment,
  type SceneEnvironment,
} from "@/scene/environment";
import { getLayout, type Layout, type Pose } from "@/scene/layouts";
import { FREE_CAMERA, type CameraAdjustments, type CameraMode } from "@/scene/camera";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { GTAOPass } from "three/addons/postprocessing/GTAOPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";

export type VehicleVisual = { id: string; color: string; label?: string; /** Body style hint: sedan, suv, hatchback... */ type?: string };

/** A point in three.js scene coordinates (meters; +x east, +y up, -z north). */
export type Point3 = [number, number, number];

export type ViewBounds = { min: Point3; max: Point3 };

export type CameraPose = { position: Point3; target: Point3 };

export type SceneMarker = { id: string; label: string; point: Point3; entityId?: string };

/** Overlays the user (or the assistant) can switch on and off. */
export type SceneLayers = { trails: boolean; bounds: boolean; hitboxes: boolean; hiddenVehicles: string[] };

export type SceneHandle = {
  showProxy: (layoutId: string, vehicles: VehicleVisual[], environment: SceneEnvironment, duration: number) => void;
  showSplat: (bytes: Uint8Array, fileName: string, environment: SceneEnvironment) => Promise<void>;
  setTime: (time: number) => void;
  setCameraAdjustments: (adjustments: CameraAdjustments) => void;
  resetCamera: () => void;
  /** Where the camera is and what it looks at, after any move in progress finishes. */
  getCamera: () => CameraPose;
  /**
   * Places the camera, clamped to the scene bounds. Animates unless `instant`.
   * Returns where it ended up and whether the bounds stopped it.
   */
  setCamera: (pose: CameraPose, options?: { instant?: boolean; /** Vertical field of view (deg), e.g. to match a source camera. */ fovDeg?: number }) => CameraPose & { clamped: boolean };
  /** Default overview of the scene, as a pose (doesn't move the camera). */
  homePose: () => CameraPose;
  bounds: () => ViewBounds;
  /** Where a vehicle's centre is at `time`, or null if the scene has no such vehicle. */
  vehiclePose: (id: string, time: number) => { position: Point3; yaw: number; /** Not in the scene at this time. */ hidden?: boolean } | null;
  /** Free camera, follow a vehicle from outside, or ride in its driver seat (see CameraMode). */
  setMode: (mode: CameraMode) => void;
  setLayers: (layers: SceneLayers) => void;
  setMarkers: (markers: SceneMarker[]) => void;
  /** Called after every rendered frame, while the frame is still in the canvas (used by export). */
  onFrame: (callback: ((canvas: HTMLCanvasElement) => void) | null) => void;
  resize: () => void;
  render: () => void;
  dispose: () => void;
};

type Mover = { id: string; rig: VehicleRig; poseAt: (time: number) => Pose; color: string; eyeHeight: number };

/** Approximate driver eye height by vehicle class (m, before the layout's scale). */
const EYE_HEIGHT: Record<VehicleKind, number> = { car: 1.2, van: 1.7, truck: 2.4 };

/** How far outside the site the camera may go (m), and how high. */
const BOUNDS_MARGIN = 20;
const BOUNDS_HEIGHT = 90;
const BOUNDS_FLOOR = 0.3;
/** Camera moves the assistant or the panel asks for glide over this long (s). */
const TWEEN_SECONDS = 0.6;
/** Driver eye point: forward of the vehicle centre (m); the height comes from EYE_HEIGHT. */
const POV_EYE_FORWARD = 0.2;
/** How far ahead of the eye the POV camera looks (m). */
const POV_LOOK_AHEAD = 12;

/** Step for finite differences on trajectories (s). */
const DT = 0.05;

function wrapAngle(angle: number) {
  return Math.atan2(Math.sin(angle), Math.cos(angle));
}

type SplatMeshLike = THREE.Object3D & {
  initialized?: Promise<unknown>;
  dispose?: () => void;
};

const LOADING_BACKGROUND = 0x9aa4b2;

const toPoint = (v: THREE.Vector3): Point3 => [v.x, v.y, v.z];
const toVector = (p: Point3) => new THREE.Vector3(p[0], p[1], p[2]);
const easeInOut = (k: number) => (k < 0.5 ? 4 * k * k * k : 1 - (-2 * k + 2) ** 3 / 2);

/** A text label that keeps the same size on screen at any distance. */
function makeLabel(text: string) {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d")!;
  const font = "600 30px system-ui, -apple-system, Segoe UI, sans-serif";
  ctx.font = font;
  const width = Math.min(640, Math.ceil(ctx.measureText(text).width) + 36);
  canvas.width = width;
  canvas.height = 52;
  ctx.font = font;
  ctx.fillStyle = "rgba(7, 20, 51, 0.88)";
  ctx.beginPath();
  ctx.roundRect(0, 0, width, 52, 14);
  ctx.fill();
  ctx.fillStyle = "#ffffff";
  ctx.textBaseline = "middle";
  ctx.fillText(text, 18, 27);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const material = new THREE.SpriteMaterial({ map: texture, sizeAttenuation: false, depthTest: false, fog: false });
  const sprite = new THREE.Sprite(material);
  const scale = 0.045;
  sprite.scale.set((scale * width) / 52, scale, 1);
  sprite.center.set(0.5, 0);
  sprite.renderOrder = 20;
  return sprite;
}

function makePin(marker: SceneMarker) {
  const group = new THREE.Group();
  group.name = `marker:${marker.id}`;
  const color = new THREE.Color("#ff8a00");
  const stem = new THREE.Mesh(
    new THREE.CylinderGeometry(0.05, 0.05, 2.6, 8),
    new THREE.MeshBasicMaterial({ color, fog: false }),
  );
  stem.position.y = 1.3;
  const head = new THREE.Mesh(
    new THREE.SphereGeometry(0.38, 20, 14),
    new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 1.6 }),
  );
  head.position.y = 2.8;
  const label = makeLabel(marker.label);
  label.position.y = 3.3;
  group.add(stem, head, label);
  return group;
}

export async function mountScene(
  container: HTMLElement,
  onCameraChange: (adjustments: CameraAdjustments) => void,
): Promise<SceneHandle> {
  // No default-framebuffer MSAA: the composer below renders into its own multisampled
  // target, so built-in antialiasing would only cost memory (~65 MB at 1080p).
  const renderer = new THREE.WebGLRenderer({ antialias: false });
  // 1.5x is visually close to 2x on HiDPI screens at ~56% of the buffer memory.
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
  renderer.setClearColor(LOADING_BACKGROUND, 1);
  // Neutral tone mapping leaves mid-tones untouched, so linear horizon colour as fog
  // matches the (untone-mapped) sRGB sky backdrop where the ground meets it.
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.domElement.style.display = "block";
  renderer.domElement.style.width = "100%";
  renderer.domElement.style.height = "100%";
  container.appendChild(renderer.domElement);

  // Post-processing chain, rendered in linear HDR:
  //   ambient occlusion (contact shadows under cars, curbs, barriers)
  //   -> bloom (only things brighter than white: lamps, brake lights, sun glints)
  //   -> tone mapping + sRGB output. Multisampling keeps edges smooth.
  const composer = new EffectComposer(
    renderer,
    new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 }),
  );

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(LOADING_BACKGROUND);

  const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 3000);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.maxPolarAngle = Math.PI / 2.05;
  controls.minDistance = 1.5;
  controls.maxDistance = 220;
  controls.zoomToCursor = true;
  controls.target.set(-2, 0, 2);

  const hemi = new THREE.HemisphereLight(0xffffff, 0xb7c0c8, 0.9);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xffffff, 1.25);
  sun.position.set(28, 42, 16);
  sun.castShadow = true;
  // 2048^2 over the site (see placeSun) keeps shadow texels around 8 cm at 16 MB.
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.far = 400;
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.02;
  scene.add(sun, sun.target);

  let sparkReady = false;
  try {
    const spark = await import("@sparkjsdev/spark");
    scene.add(new spark.SparkRenderer({ renderer }));
    sparkReady = true;
  } catch (error) {
    console.error("Spark failed to initialize", error);
  }

  const proxy = new THREE.Group();
  scene.add(proxy);

  // Overlays: never part of the reconstruction, only drawn on top of it.
  const trailsGroup = new THREE.Group();
  const markersGroup = new THREE.Group();
  const boundsGroup = new THREE.Group();
  scene.add(trailsGroup, markersGroup, boundsGroup);

  composer.addPass(new RenderPass(scene, camera));
  const ambientOcclusion = new GTAOPass(scene, camera, 1, 1);
  ambientOcclusion.updateGtaoMaterial({ radius: 0.9, distanceExponent: 1.5, thickness: 1.5, scale: 1.1, samples: 16 });
  ambientOcclusion.blendIntensity = 0.85;
  composer.addPass(ambientOcclusion);
  const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.6, 0.35, 2.4);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());

  let environment: SceneEnvironment | null = null;
  let pack = resolveEnvironment(DEFAULT_ENVIRONMENT);
  let skyToken = 0;
  let shownSky: string | null = null;
  let sunDirection = new THREE.Vector3(28, 42, 16).normalize();
  let currentLayout: Layout | null = null;
  let splatMesh: SplatMeshLike | null = null;
  let movers: Mover[] = [];
  let duration = 0;
  let viewBounds: ViewBounds = { min: [-150, BOUNDS_FLOOR, -150], max: [150, BOUNDS_HEIGHT, 150] };
  let layers: SceneLayers = { trails: false, bounds: true, hitboxes: false, hiddenVehicles: [] };
  let markers: SceneMarker[] = [];
  let markerObjects = new Map<string, THREE.Group>();
  let mode: CameraMode = FREE_CAMERA;
  /** True for the vehicle the POV camera sits in (it is hidden so it doesn't block the view). */
  const ridingIn = (id: string) => mode.kind === "pov" && mode.entityId === id;
  let lastTime = 0;
  let frameCallback: ((canvas: HTMLCanvasElement) => void) | null = null;
  let tween: {
    fromTarget: THREE.Vector3;
    toTarget: THREE.Vector3;
    from: THREE.Spherical;
    to: THREE.Spherical;
    start: number;
  } | null = null;
  const home = {
    position: new THREE.Vector3(34, 30, 36),
    target: new THREE.Vector3(-2, 0, 2),
  };

  // Panel readout of the camera; throttled because follow and POV move the camera every frame.
  let lastCameraReport = 0;
  let cameraReportPending = false;
  const readCameraAdjustments = (): CameraAdjustments => {
    const baseOffset = home.position.clone().sub(home.target);
    const base = new THREE.Spherical().setFromVector3(baseOffset);
    const offset = camera.position.clone().sub(controls.target);
    const current = new THREE.Spherical().setFromVector3(offset);
    const round = (value: number) => Math.round(value * 1000) / 1000;
    return {
      panX: round(controls.target.x - home.target.x),
      panY: round(controls.target.y - home.target.y),
      panZ: round(controls.target.z - home.target.z),
      zoom: round(current.radius / base.radius),
      tilt: round(THREE.MathUtils.radToDeg(current.phi - base.phi)),
      rotate: round(THREE.MathUtils.radToDeg(wrapAngle(current.theta - base.theta))),
    };
  };
  const reportCamera = (force = false) => {
    const now = performance.now();
    if (!force && now - lastCameraReport < 100) {
      cameraReportPending = true;
      return;
    }
    lastCameraReport = now;
    cameraReportPending = false;
    onCameraChange(readCameraAdjustments());
  };
  controls.addEventListener("change", () => reportCamera());

  /** Clamps a point into the scene box in place; true if it had to move. */
  const clampToBounds = (point: THREE.Vector3, floor = viewBounds.min[1]) => {
    const before = point.clone();
    point.set(
      THREE.MathUtils.clamp(point.x, viewBounds.min[0], viewBounds.max[0]),
      THREE.MathUtils.clamp(point.y, floor, viewBounds.max[1]),
      THREE.MathUtils.clamp(point.z, viewBounds.min[2], viewBounds.max[2]),
    );
    return before.distanceToSquared(point) > 1e-8;
  };

  /**
   * Applies the same limits the orbit controls enforce (distance, not below the horizon)
   * and the scene box, so the pose we report is the pose the camera really takes.
   */
  const constrain = (position: THREE.Vector3, target: THREE.Vector3) => {
    // The look-at point may sit on the ground; only the camera has to stay above the floor.
    let limited = clampToBounds(target, Math.min(0, viewBounds.min[1]));
    const offset = position.clone().sub(target);
    if (offset.lengthSq() < 1e-6) offset.set(0, 1, 0);
    const spherical = new THREE.Spherical().setFromVector3(offset);
    const phi = THREE.MathUtils.clamp(spherical.phi, 1e-4, controls.maxPolarAngle);
    const radius = THREE.MathUtils.clamp(spherical.radius, controls.minDistance, controls.maxDistance);
    if (Math.abs(phi - spherical.phi) > 1e-3 || Math.abs(radius - spherical.radius) > 1e-3) limited = true;
    spherical.phi = phi;
    spherical.radius = radius;
    const next = target.clone().add(new THREE.Vector3().setFromSpherical(spherical));
    if (clampToBounds(next)) limited = true;
    return { position: next, target, limited };
  };

  const stopMotion = () => {
    tween = null;
  };

  const placeNow = (position: THREE.Vector3, target: THREE.Vector3) => {
    stopMotion();
    camera.position.copy(position);
    controls.target.copy(target);
    controls.saveState();
    controls.reset();
    reportCamera(true);
  };

  const glideTo = (position: THREE.Vector3, target: THREE.Vector3) => {
    const from = new THREE.Spherical().setFromVector3(camera.position.clone().sub(controls.target));
    const to = new THREE.Spherical().setFromVector3(position.clone().sub(target));
    // Turn the short way round.
    to.theta = from.theta + wrapAngle(to.theta - from.theta);
    tween = { fromTarget: controls.target.clone(), toTarget: target.clone(), from, to, start: performance.now() };
  };

  const stepTween = (now: number) => {
    if (!tween) return;
    const k = Math.min(1, (now - tween.start) / (TWEEN_SECONDS * 1000));
    const e = easeInOut(k);
    controls.target.lerpVectors(tween.fromTarget, tween.toTarget, e);
    const spherical = new THREE.Spherical(
      THREE.MathUtils.lerp(tween.from.radius, tween.to.radius, e),
      THREE.MathUtils.lerp(tween.from.phi, tween.to.phi, e),
      THREE.MathUtils.lerp(tween.from.theta, tween.to.theta, e),
    );
    camera.position.copy(controls.target).add(new THREE.Vector3().setFromSpherical(spherical));
    if (k >= 1) tween = null;
  };

  const setCameraAdjustments = (adjustments: CameraAdjustments) => {
    const baseOffset = home.position.clone().sub(home.target);
    const base = new THREE.Spherical().setFromVector3(baseOffset);
    const target = home.target.clone().add(
      new THREE.Vector3(adjustments.panX, adjustments.panY, adjustments.panZ),
    );
    const minZoom = controls.minDistance / base.radius;
    const maxZoom = controls.maxDistance / base.radius;
    const radius = base.radius * THREE.MathUtils.clamp(adjustments.zoom, minZoom, maxZoom);
    const phi = THREE.MathUtils.clamp(
      base.phi + THREE.MathUtils.degToRad(adjustments.tilt),
      0.001,
      controls.maxPolarAngle,
    );
    const theta = base.theta + THREE.MathUtils.degToRad(adjustments.rotate);
    const position = target.clone().add(new THREE.Vector3().setFromSpherical(new THREE.Spherical(radius, phi, theta)));
    const placed = constrain(position, target);
    leaveCameraModes();
    placeNow(placed.position, placed.target);
  };

  const placeSun = () => {
    const center = currentLayout ? new THREE.Vector3(0, 0, 0) : controls.target.clone();
    const extent = currentLayout ? Math.max(currentLayout.site.width, currentLayout.site.depth) * 0.55 : 70;
    sun.target.position.copy(center);
    sun.position.copy(center).addScaledVector(sunDirection, 200);
    const shadow = sun.shadow.camera;
    shadow.left = -extent;
    shadow.right = extent;
    shadow.top = extent;
    shadow.bottom = -extent;
    shadow.updateProjectionMatrix();
  };

  const applyAtmosphere = () => {
    const token = ++skyToken;
    sun.color.set(pack.sunColor);
    sun.intensity = pack.sunIntensity;
    hemi.intensity = pack.hemiIntensity;

    void loadSky(pack.sky)
      .then((sky) => {
        if (token !== skyToken) return;
        // Free the sky we're replacing only now that the new one is on screen.
        if (shownSky && shownSky !== pack.sky) releaseSky(shownSky);
        shownSky = pack.sky;
        scene.background = sky.backdrop;
        scene.backgroundIntensity = pack.backgroundIntensity;
        scene.environment = sky.lighting;
        scene.environmentIntensity = pack.envIntensity;
        hemi.color.copy(sky.horizon);
        hemi.groundColor.set(0x5b5a50);
        const fog = new THREE.FogExp2(0xffffff, pack.fogDensity);
        // Match the backdrop as displayed, which night scales down.
        fog.color.copy(sky.horizon).multiplyScalar(pack.backgroundIntensity);
        scene.fog = fog;
        sunDirection = sky.sunDirection.clone();
        placeSun();
      })
      .catch((error) => console.error("Could not load sky", error));
  };

  /** Switches sky, light and materials; returns true when anything changed. */
  const useEnvironment = (next: SceneEnvironment) => {
    if (environment && environmentKey(environment) === environmentKey(next)) return false;
    environment = next;
    pack = resolveEnvironment(next);
    applyAtmosphere();
    return true;
  };

  const resize = () => {
    const width = container.clientWidth || 1;
    const height = container.clientHeight || 1;
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height, false);
    composer.setPixelRatio(renderer.getPixelRatio());
    composer.setSize(width, height);
  };

  const applyHome = () => {
    leaveCameraModes();
    placeNow(home.position.clone(), home.target.clone());
  };

  const disposeObject = (object: THREE.Object3D) => {
    object.traverse((child) => {
      const mesh = child as THREE.Mesh;
      mesh.geometry?.dispose();
      const material = mesh.material;
      const disposeMaterial = (item: THREE.Material) => {
        // Canvas textures (signs, labels) are per-scene; shared texture files stay cached.
        const map = (item as THREE.MeshStandardMaterial).map;
        if (map instanceof THREE.CanvasTexture) map.dispose();
        item.dispose();
      };
      if (Array.isArray(material)) material.forEach(disposeMaterial);
      else if (material) disposeMaterial(material);
    });
  };

  const clearGroup = (group: THREE.Group) => {
    for (const child of [...group.children]) {
      group.remove(child);
      disposeObject(child);
    }
  };

  const clearProxy = () => {
    movers = [];
    clearGroup(proxy);
    clearGroup(trailsGroup);
  };

  const clearSplat = () => {
    if (!splatMesh) return;
    scene.remove(splatMesh);
    splatMesh.dispose?.();
    splatMesh = null;
  };

  const setBounds = (next: ViewBounds) => {
    viewBounds = next;
    clearGroup(boundsGroup);
    const size = toVector(next.max).sub(toVector(next.min));
    const center = toVector(next.min).add(size.clone().multiplyScalar(0.5));
    const box = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(size.x, size.y, size.z)),
      new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.7, fog: false }),
    );
    box.position.copy(center);
    boundsGroup.add(box);
    boundsGroup.visible = layers.bounds;
  };

  /** Each vehicle's path over the whole clip, split where a looped road jumps back. */
  const buildTrails = () => {
    clearGroup(trailsGroup);
    if (duration <= 0) return;
    const step = 0.1;
    for (const mover of movers) {
      let run: THREE.Vector3[] = [];
      const flush = () => {
        if (run.length > 1) {
          const line = new THREE.Line(
            new THREE.BufferGeometry().setFromPoints(run),
            new THREE.LineBasicMaterial({ color: mover.color, fog: false, depthTest: false, transparent: true, opacity: 0.95 }),
          );
          line.name = `trail:${mover.id}`;
          line.renderOrder = 10;
          trailsGroup.add(line);
        }
        run = [];
      };
      for (let t = 0; t <= duration + 1e-6; t += step) {
        const pose = mover.poseAt(t);
        // Only where the vehicle is on the road; it's parked out of view before it enters / after it leaves.
        if (pose.hidden) {
          flush();
          continue;
        }
        const point = new THREE.Vector3(pose.x, 0.3, pose.z);
        if (run.length && run[run.length - 1].distanceTo(point) > 15) flush();
        run.push(point);
      }
      flush();
    }
    trailsGroup.visible = layers.trails;
  };

  const applyVehicleVisibility = () => {
    for (const mover of movers) {
      mover.rig.root.visible = !mover.poseAt(lastTime).hidden && !layers.hiddenVehicles.includes(mover.id) && !ridingIn(mover.id);
      const hitbox = mover.rig.root.getObjectByName("vehicle-hitbox");
      if (hitbox) hitbox.visible = layers.hitboxes;
    }
    for (const line of trailsGroup.children) {
      const id = line.name.slice("trail:".length);
      line.visible = !layers.hiddenVehicles.includes(id);
    }
  };

  const placeMarkers = () => {
    for (const marker of markers) {
      const object = markerObjects.get(marker.id);
      if (!object) continue;
      const mover = marker.entityId ? movers.find((item) => item.id === marker.entityId) : undefined;
      if (mover) object.position.set(mover.rig.root.position.x, 0, mover.rig.root.position.z);
      else object.position.set(...marker.point);
      // A pin on a vehicle goes away with it while it's off the road.
      object.visible = !mover || !mover.poseAt(lastTime).hidden;
    }
  };

  const setMarkers = (next: SceneMarker[]) => {
    const keep = new Set(next.map((item) => item.id));
    for (const [id, object] of markerObjects) {
      if (keep.has(id)) continue;
      markersGroup.remove(object);
      disposeObject(object);
      markerObjects.delete(id);
    }
    for (const marker of next) {
      if (markerObjects.has(marker.id)) continue;
      const object = makePin(marker);
      markersGroup.add(object);
      markerObjects.set(marker.id, object);
    }
    markers = next;
    placeMarkers();
  };

  const buildProxy = (layout: Layout, vehicles: VehicleVisual[]) => {
    clearProxy();
    const surfaces = createSurfaces(pack);
    const painter = new Painter(proxy, surfaces, layout.site);
    layout.build(painter);
    buildSurroundings(proxy, pack, surfaces, layout.site, painter.obstacles);
    applyWorldUVs(proxy);
    proxy.visible = true;

    for (const vehicle of vehicles) {
      const motion = layout.vehicles.find((item) => item.id === vehicle.id);
      if (!motion) continue;
      const kind = motion.kind ?? "car";
      const scale = motion.scale ?? 1;
      const rig = makeVehicle(kind, vehicle.color, vehicle.id, `${vehicle.label ?? ""} ${vehicle.type ?? ""}`);
      rig.root.scale.setScalar(scale);
      proxy.add(rig.root);
      movers.push({ id: vehicle.id, rig, poseAt: motion.poseAt, color: vehicle.color, eyeHeight: EYE_HEIGHT[kind] * scale });
    }
    buildTrails();
    applyVehicleVisibility();
    placeSun();
  };

  const leaveCameraModes = () => {
    const wasPov = mode.kind === "pov";
    mode = FREE_CAMERA;
    if (wasPov) {
      controls.enabled = true;
      applyVehicleVisibility();
    }
  };

  const showProxy = (layoutId: string, vehicles: VehicleVisual[], next: SceneEnvironment, clipDuration: number) => {
    const layout = getLayout(layoutId);
    if (!layout) return;
    useEnvironment(next);
    clearSplat();
    ambientOcclusion.enabled = true;
    currentLayout = layout;
    duration = clipDuration;
    leaveCameraModes();
    buildProxy(layout, vehicles);
    const halfW = layout.site.width / 2 + BOUNDS_MARGIN;
    const halfD = layout.site.depth / 2 + BOUNDS_MARGIN;
    setBounds({ min: [-halfW, BOUNDS_FLOOR, -halfD], max: [halfW, BOUNDS_HEIGHT, halfD] });
    home.position.set(...layout.camera.position);
    home.target.set(...layout.camera.target);
    applyHome();
  };

  const frameObject = (object: THREE.Object3D) => {
    const box = new THREE.Box3().setFromObject(object);
    if (box.isEmpty()) return;
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const radius = Math.max(size.x, size.y, size.z, 1);
    const reach = radius * 1.5 + BOUNDS_MARGIN;
    setBounds({
      min: [center.x - reach, Math.min(box.min.y, center.y - radius * 0.5), center.z - reach],
      max: [center.x + reach, center.y + reach, center.z + reach],
    });
    home.target.copy(center);
    home.position.copy(center).add(new THREE.Vector3(radius * 0.9, radius * 0.72, radius * 0.95));
    applyHome();
  };

  const showSplat = async (bytes: Uint8Array, fileName: string, next: SceneEnvironment) => {
    if (!sparkReady) {
      throw new Error("Spark is not available in this window, so the splat file cannot be rendered.");
    }
    const spark = await import("@sparkjsdev/spark");
    useEnvironment(next);
    clearSplat();
    clearProxy();
    leaveCameraModes();
    currentLayout = null;
    duration = 0;
    proxy.visible = false;
    // Ambient occlusion is computed from mesh depth/normals; splats don't provide them.
    ambientOcclusion.enabled = false;

    const copy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    const mesh = new spark.SplatMesh({ fileBytes: copy, fileName }) as SplatMeshLike;
    mesh.quaternion.set(1, 0, 0, 0);
    scene.add(mesh);
    splatMesh = mesh;
    if (mesh.initialized) await mesh.initialized;
    frameObject(mesh);
  };

  /** Speed along the heading at `time`, by central difference. */
  const speedAt = (poseAt: (time: number) => Pose, time: number) => {
    const a = poseAt(time - DT);
    const b = poseAt(time + DT);
    const heading = poseAt(time).yaw;
    return ((b.x - a.x) * Math.sin(heading) + (b.z - a.z) * Math.cos(heading)) / (2 * DT);
  };

  const setTime = (time: number) => {
    lastTime = time;
    for (const mover of movers) {
      const pose = mover.poseAt(time);
      mover.rig.root.position.set(pose.x, 0, pose.z);
      mover.rig.root.rotation.y = pose.yaw;
      mover.rig.root.visible = !pose.hidden && !layers.hiddenVehicles.includes(mover.id) && !ridingIn(mover.id);

      // Motion state from the trajectory itself, so any poseAt (scripted now, simulated
      // or tracked later) drives wheels, brake lights and suspension consistently.
      const speed = speedAt(mover.poseAt, time);
      let accel = (speedAt(mover.poseAt, time + DT) - speedAt(mover.poseAt, time - DT)) / (2 * DT);
      // A looped road teleports cars; ignore the resulting spike.
      if (!Number.isFinite(accel) || Math.abs(accel) > 15) accel = 0;
      const yawRate = wrapAngle(mover.poseAt(time + DT).yaw - mover.poseAt(time - DT).yaw) / (2 * DT);
      driveVehicle(mover.rig, { speed, accel, yawRate: Math.abs(speed) > 0.2 ? yawRate : 0, lamps: pack.lamps });
    }
    placeMarkers();
  };

  const followPoint = (mover: Mover) => mover.rig.root.position.clone().add(new THREE.Vector3(0, 0.8, 0));

  /** Keeps the followed vehicle at the orbit centre, carrying the camera along with it. */
  const updateFollow = () => {
    const current = mode;
    const mover = current.kind === "follow" ? movers.find((item) => item.id === current.entityId) : undefined;
    if (!mover) return;
    const point = followPoint(mover);
    const delta = point.clone().sub(tween ? tween.toTarget : controls.target);
    if (delta.lengthSq() < 1e-10) return;
    if (tween) {
      tween.toTarget.add(delta);
      tween.fromTarget.add(delta);
    } else {
      camera.position.add(delta);
      controls.target.copy(point);
    }
  };

  const updatePov = () => {
    const current = mode;
    const mover = current.kind === "pov" ? movers.find((item) => item.id === current.entityId) : undefined;
    if (!mover) return;
    const yaw = mover.rig.root.rotation.y;
    const forward = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw));
    const eye = mover.rig.root.position
      .clone()
      .addScaledVector(forward, POV_EYE_FORWARD * mover.rig.root.scale.x)
      .add(new THREE.Vector3(0, mover.eyeHeight, 0));
    const ahead = eye.clone().addScaledVector(forward, POV_LOOK_AHEAD);
    ahead.y = eye.y - 0.4;
    camera.position.copy(eye);
    controls.target.copy(ahead);
    camera.lookAt(ahead);
  };

  const observer = new ResizeObserver(resize);
  observer.observe(container);
  resize();

  let disposed = false;

  return {
    showProxy,
    showSplat,
    setTime,
    setCameraAdjustments,
    resetCamera: () => {
      leaveCameraModes();
      const placed = constrain(home.position.clone(), home.target.clone());
      glideTo(placed.position, placed.target);
    },
    getCamera: () => {
      if (tween) {
        const position = tween.toTarget.clone().add(new THREE.Vector3().setFromSpherical(tween.to));
        return { position: toPoint(position), target: toPoint(tween.toTarget) };
      }
      return { position: toPoint(camera.position), target: toPoint(controls.target) };
    },
    setCamera: (pose, options = {}) => {
      if (mode.kind === "pov") leaveCameraModes();
      const placed = constrain(toVector(pose.position), toVector(pose.target));
      if (options.fovDeg && Math.abs(camera.fov - options.fovDeg) > 1e-9) {
        camera.fov = THREE.MathUtils.clamp(options.fovDeg, 1, 120);
        camera.updateProjectionMatrix();
      }
      if (options.instant) placeNow(placed.position, placed.target);
      else glideTo(placed.position, placed.target);
      return { position: toPoint(placed.position), target: toPoint(placed.target), clamped: placed.limited };
    },
    homePose: () => ({ position: toPoint(home.position), target: toPoint(home.target) }),
    bounds: () => ({ min: [...viewBounds.min], max: [...viewBounds.max] }),
    vehiclePose: (id, time) => {
      const mover = movers.find((item) => item.id === id);
      if (!mover) return null;
      const pose = mover.poseAt(time);
      return { position: [pose.x, 0, pose.z], yaw: pose.yaw, ...(pose.hidden ? { hidden: true } : {}) };
    },
    setMode: (next) => {
      if (next.kind !== "pov") {
        // Free or follow: the user's controls are live again.
        leaveCameraModes();
        mode = next;
        return;
      }
      stopMotion();
      mode = next;
      controls.enabled = false;
      applyVehicleVisibility();
    },
    setLayers: (next) => {
      layers = { ...next, hiddenVehicles: [...next.hiddenVehicles] };
      trailsGroup.visible = layers.trails;
      boundsGroup.visible = layers.bounds;
      applyVehicleVisibility();
    },
    setMarkers,
    onFrame: (callback) => {
      frameCallback = callback;
    },
    resize,
    render: () => {
      if (disposed) return;
      const now = performance.now();
      if (mode.kind === "pov") {
        updatePov();
      } else {
        if (mode.kind === "follow") updateFollow();
        stepTween(now);
        controls.update();
        clampToBounds(camera.position);
      }
      if (cameraReportPending && now - lastCameraReport >= 100) reportCamera();
      composer.render();
      frameCallback?.(renderer.domElement);
    },
    dispose: () => {
      disposed = true;
      skyToken += 1;
      observer.disconnect();
      controls.dispose();
      clearProxy();
      clearSplat();
      clearGroup(markersGroup);
      clearGroup(boundsGroup);
      composer.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}
