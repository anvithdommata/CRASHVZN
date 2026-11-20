/**
 * Per-frame kinematics database (MongoDB), in the Electron main process.
 *
 * One document per object per frame: position, velocity, speed, acceleration, heading,
 * yaw rate and net force, in the assistant's world frame (meters, +x east, +y up, -z north,
 * origin at the crash point). The renderer and the assistant read it; only `kinematics:sync`
 * writes, and that's called by the app, never by a model tool.
 *
 * Where it lives:
 *   - MONGODB_URI set (Atlas, a team server, a local mongod): that database.
 *   - otherwise an embedded mongod (mongodb-memory-server) storing its files in
 *     <userData>/mongo, so demos need no setup and the data survives restarts.
 *
 * Collections (database MONGODB_DB, default "reconstruct"):
 *   incidents  { _id, title, hash, fps, duration_s, origin_scene, crash, entities[], basis, physics, contacts[], synced_at }
 *              Static scenery (median verge, barrier) is an entity with type "static": immovable,
 *              zero velocity/acceleration in every frame, footprint and material under `static`.
 *   frames     { incident_id, entity_id, t, frame, position, velocity, speed, accel, accel_long,
 *                heading_deg, yaw_rate_dps, mass_kg, force_net, force_parts, force_reported,
 *                involvement, sigma }
 *   analyses   The vision model's reading of uploaded footage (electron/analysis.ts; legacy name)
 *   scenes     Reconstructed scenes in the library: analysis id + seed, rebuilt by the engine at startup
 * Frames are stored at the renderer's derivation rate (src/kinematics/derive.ts FPS = 30), not the
 * source video's frame rate. See docs/kinematics-database.md.
 * The tracking pipeline's real output (tracks.json) is meant to be loaded through the same
 * sync call, with `sigma` filled in and basis "tracked from the footage".
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { App, IpcMain } from "electron";
import type { Collection, Db, MongoClient as MongoClientType } from "mongodb";

type Vec3 = [number, number, number];

export type FrameDoc = {
  incident_id: string;
  entity_id: string;
  t: number;
  frame: number;
  position: Vec3;
  velocity: Vec3;
  speed: number;
  accel: Vec3;
  /** Signed along the direction of travel; negative = slowing. */
  accel_long: number;
  /** Compass bearing of travel, 0 = north, 90 = east. */
  heading_deg: number;
  /** Positive = turning right (clockwise seen from above). */
  yaw_rate_dps: number;
  mass_kg: number;
  /** Net force = mass × acceleration, world frame (N). */
  force_net: Vec3;
  /** force_net split into tyre/road, air drag, rolling resistance, slope and impact (sums to force_net). */
  force_parts?: { tyre_road: Vec3; drag: Vec3; rolling: Vec3; grade: Vec3; contact: Vec3 };
  /** The vision model's own force reading near this time. */
  force_reported?: { vector: Vec3; cause: string; note: string } | null;
  involvement?: "crash" | "background";
  sigma: { position_m?: number; speed_mps?: number; accel_mps2?: number } | null;
};

export type IncidentDoc = {
  _id: string;
  title: string;
  hash: string;
  fps: number;
  duration_s: number;
  origin_scene: Vec3;
  crash: { start_s: number; end_s: number; vehicles: string[] } | null;
  entities: {
    id: string;
    label: string;
    type: string;
    mass_kg: number;
    from_s: number;
    to_s: number;
    involvement?: "crash" | "background";
    /** Fixed scenery only (type "static"). */
    static?: {
      kind: string;
      footprint: Vec3[];
      height_m: number | null;
      material: string | null;
      friction: number | null;
      restitution: number | null;
      stiffness_n_per_m: number | null;
      immovable: boolean;
      sigma_m: number | null;
      source: string | null;
      note: string | null;
    };
  }[];
  basis: string;
  physics?: { wind: Vec3; gradePercent: number; surface: string; mu: number; air_density: number };
  /** Contacts in time order: a pushes b along `normal`; force_avg_n is the mean force on b over window_s. */
  contacts?: {
    a: string;
    b: string;
    kind: string;
    t_s: number;
    frame: number;
    point: Vec3 | null;
    normal: Vec3 | null;
    impulse_ns: number | null;
    impulse_basis: "spec" | "derived" | null;
    window_s: number;
    force_avg_n: Vec3 | null;
    source: string | null;
    note: string | null;
  }[];
  synced_at: Date;
};

type Status = { state: "starting" | "ready" | "error"; mode?: "embedded" | "external"; error?: string };

/** Above this jump between two frames (m) the object left and re-entered; don't blend across it. */
const TELEPORT_M = 15;

const lerp = (a: number, b: number, k: number) => a + (b - a) * k;
const lerp3 = (a: Vec3, b: Vec3, k: number): Vec3 => [lerp(a[0], b[0], k), lerp(a[1], b[1], k), lerp(a[2], b[2], k)];
const lerpAngle = (a: number, b: number, k: number) => {
  const d = ((((b - a) % 360) + 540) % 360) - 180;
  return (((a + d * k) % 360) + 360) % 360;
};
const dist = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

function blend(a: FrameDoc, b: FrameDoc, t: number): FrameDoc {
  if (b.t === a.t || dist(a.position, b.position) > TELEPORT_M) return { ...(t - a.t <= b.t - t ? a : b), t };
  const k = (t - a.t) / (b.t - a.t);
  return {
    ...a,
    t,
    frame: a.frame,
    position: lerp3(a.position, b.position, k),
    velocity: lerp3(a.velocity, b.velocity, k),
    speed: lerp(a.speed, b.speed, k),
    accel: lerp3(a.accel, b.accel, k),
    accel_long: lerp(a.accel_long, b.accel_long, k),
    heading_deg: lerpAngle(a.heading_deg, b.heading_deg, k),
    yaw_rate_dps: lerp(a.yaw_rate_dps, b.yaw_rate_dps, k),
    force_net: lerp3(a.force_net, b.force_net, k),
    ...(a.force_parts && b.force_parts
      ? {
          force_parts: {
            tyre_road: lerp3(a.force_parts.tyre_road, b.force_parts.tyre_road, k),
            drag: lerp3(a.force_parts.drag, b.force_parts.drag, k),
            rolling: lerp3(a.force_parts.rolling, b.force_parts.rolling, k),
            grade: lerp3(a.force_parts.grade, b.force_parts.grade, k),
            contact: lerp3(a.force_parts.contact, b.force_parts.contact, k),
          },
        }
      : {}),
    force_reported: k < 0.5 ? a.force_reported : b.force_reported,
  };
}

/** Values at each requested time from frames sorted by t; null where the object has no data. */
function sampleAt(frames: FrameDoc[], times: number[], fps: number): (FrameDoc | null)[] {
  const tolerance = 1.5 / fps;
  return times.map((t) => {
    let hi = frames.findIndex((frame) => frame.t >= t);
    if (hi === -1) hi = frames.length;
    const after = frames[hi];
    const before = frames[hi - 1];
    if (after && Math.abs(after.t - t) < 1e-9) return { ...after, t };
    if (before && after) return blend(before, after, t);
    const edge = before ?? after;
    return edge && Math.abs(edge.t - t) <= tolerance ? { ...edge, t } : null;
  });
}

export function registerKinematics({ ipcMain, app }: { ipcMain: IpcMain; app: App }) {
  let status: Status = { state: "starting" };
  let client: MongoClientType | null = null;
  let server: { stop: (opts?: { doCleanup?: boolean }) => Promise<boolean> } | null = null;

  const ready: Promise<Db> = (async () => {
    // Loaded at runtime from node_modules (kept out of the esbuild bundle).
    const { MongoClient } = await import("mongodb");
    let uri = process.env.MONGODB_URI;
    let mode: Status["mode"] = "external";
    if (!uri) {
      const { MongoMemoryServer } = await import("mongodb-memory-server");
      const dbPath = join(app.getPath("userData"), "mongo");
      mkdirSync(dbPath, { recursive: true });
      const embedded = await MongoMemoryServer.create({ instance: { dbPath, storageEngine: "wiredTiger" } });
      server = embedded;
      uri = embedded.getUri();
      mode = "embedded";
    }
    client = await MongoClient.connect(uri, { serverSelectionTimeoutMS: 8000 });
    const db = client.db(process.env.MONGODB_DB ?? "reconstruct");
    await db.collection<FrameDoc>("frames").createIndex({ incident_id: 1, entity_id: 1, t: 1 }, { unique: true });
    await db.collection<FrameDoc>("frames").createIndex({ incident_id: 1, t: 1 });
    status = { state: "ready", mode };
    return db;
  })();
  ready.catch((error: unknown) => {
    status = { state: "error", error: error instanceof Error ? error.message : String(error) };
    console.error("Kinematics database failed to start", error);
  });

  const frames = async () => (await ready).collection<FrameDoc>("frames");
  const incidents = async () => (await ready).collection<IncidentDoc>("incidents");

  const requireIncident = async (incidentId: string) => {
    const meta = await (await incidents()).findOne({ _id: incidentId });
    if (!meta) throw new Error("This reconstruction has no per-frame motion data in the database.");
    return meta;
  };

  const loadRange = async (col: Collection<FrameDoc>, incidentId: string, entityId: string, from: number, to: number) =>
    col
      .find({ incident_id: incidentId, entity_id: entityId, t: { $gte: from, $lte: to } }, { projection: { _id: 0 } })
      .sort({ t: 1 })
      .toArray();

  ipcMain.handle("kinematics:status", async () => status);

  /**
   * The write running (or last queued) per incident. Writes to one incident run one after another:
   * a sync deletes the incident's frames and re-inserts them, so two overlapping syncs would collide
   * on the unique (incident, entity, t) index. React StrictMode's double-run of startup effects did
   * exactly that when restoring saved scenes; the queued sync then sees the same hash and skips.
   * Deleting an incident goes through the same queue, so a sync still in flight can't re-insert
   * frames after the delete.
   */
  const writeQueue = new Map<string, Promise<unknown>>();
  const enqueue = <T>(incidentId: string, work: () => Promise<T>): Promise<T> => {
    const previous = writeQueue.get(incidentId) ?? Promise.resolve();
    const job = previous.catch(() => undefined).then(work);
    writeQueue.set(incidentId, job);
    void job.finally(() => {
      if (writeQueue.get(incidentId) === job) writeQueue.delete(incidentId);
    }).catch(() => {});
    return job;
  };

  /** Replaces an incident's frames unless the stored copy has the same content hash. */
  ipcMain.handle("kinematics:sync", (_event, meta: Omit<IncidentDoc, "synced_at">, rows: FrameDoc[]) =>
    enqueue(meta._id, () => syncIncident(meta, rows)),
  );

  const syncIncident = async (meta: Omit<IncidentDoc, "synced_at">, rows: FrameDoc[]) => {
    const incidentCol = await incidents();
    const existing = await incidentCol.findOne({ _id: meta._id }, { projection: { hash: 1 } });
    if (existing?.hash === meta.hash) return { synced: false, frames: 0 };
    const col = await frames();
    await col.deleteMany({ incident_id: meta._id });
    const chunk = 5000;
    for (let i = 0; i < rows.length; i += chunk) {
      await col.insertMany(rows.slice(i, i + chunk), { ordered: false, writeConcern: { j: true } });
    }
    await incidentCol.replaceOne({ _id: meta._id }, { ...meta, synced_at: new Date() }, { upsert: true, writeConcern: { j: true } });
    return { synced: true, frames: rows.length };
  };

  ipcMain.handle("kinematics:incident", async (_event, incidentId: string) => requireIncident(incidentId));

  /** One object's values at each time (interpolated between frames); null where it has no data. */
  ipcMain.handle("kinematics:sample", async (_event, incidentId: string, entityId: string, times: number[]) => {
    const meta = await requireIncident(incidentId);
    if (!meta.entities.some((entity) => entity.id === entityId)) throw new Error(`No motion data for "${entityId}".`);
    if (!times.length) return [];
    const pad = 2 / meta.fps;
    const rows = await loadRange(await frames(), incidentId, entityId, Math.min(...times) - pad, Math.max(...times) + pad);
    return sampleAt(rows, times, meta.fps);
  });

  /** Every object's position at one time, for distances and "what's near what". */
  ipcMain.handle("kinematics:positions", async (_event, incidentId: string, t: number) => {
    const meta = await requireIncident(incidentId);
    const pad = 2 / meta.fps;
    const col = await frames();
    const out: { entity_id: string; position: Vec3 }[] = [];
    for (const entity of meta.entities) {
      const rows = await loadRange(col, incidentId, entity.id, t - pad, t + pad);
      const at = sampleAt(rows, [t], meta.fps)[0];
      if (at) out.push({ entity_id: entity.id, position: at.position });
    }
    return out;
  });

  return {
    /** The database, for the vision pipeline's (electron/analysis.ts) analyses and scenes collections. */
    db: () => ready,
    /** Removes an incident's frames and its incidents doc, after any sync of it still in flight. */
    forget: (incidentId: string) =>
      enqueue(incidentId, async () => {
        await (await frames()).deleteMany({ incident_id: incidentId });
        await (await incidents()).deleteOne({ _id: incidentId });
      }),
    dispose: async () => {
      try {
        // Flush to disk before the embedded server stops, so nothing is lost on Windows.
        if (client && server) await client.db("admin").command({ fsync: 1 });
        await client?.close();
        await server?.stop({ doCleanup: false });
      } catch (error) {
        console.error("Kinematics database didn't close cleanly", error);
      }
    },
  };
}
