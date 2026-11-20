/**
 * Camera-grid footage: one video with several camera views tiled in it (2×2 CCTV mosaics are
 * common). The vision model reads each view far better as its own full-resolution clip than as a quarter
 * of a frame, so this finds the tiles and crops each into its own file with ffmpeg.
 *
 * Detection: tiles are separated by thin, uniformly dark gutter lines. We grab a few frames,
 * average each pixel column and row, and look for dark runs in the middle third of the frame
 * (gutters) and at the edges (letterbox, trimmed off). No gutters found = not a grid.
 *
 * ffmpeg: FFMPEG_PATH, or `ffmpeg` on PATH. Without it, grid videos are sent whole (the vision model is
 * still told to read each tile), and the caller records why.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, promises as fs } from "node:fs";
import { join } from "node:path";

export type Tile = { label: string; crop: { x: number; y: number; w: number; h: number } };
export type GridSplit = { tiles: Tile[]; width: number; height: number };

const FFMPEG = () => process.env.FFMPEG_PATH || "ffmpeg";
/** A gutter line averages darker than this (0-255). */
const DARK = 28;
const MIN_TILE = { w: 200, h: 140 };

function run(args: string[], maxBuffer = 64 * 1024 * 1024): Promise<{ stdout: Buffer; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(FFMPEG(), args, { encoding: "buffer", maxBuffer, windowsHide: true }, (error, stdout, stderr) => {
      const err = stderr.toString();
      if (error && !stdout.length) reject(Object.assign(error, { stderr: err }));
      else resolve({ stdout, stderr: err });
    });
  });
}

export async function ffmpegAvailable() {
  try {
    await run(["-version"]);
    return true;
  } catch {
    return false;
  }
}

async function dimensions(path: string) {
  // `ffmpeg -i` with no output prints the stream info to stderr and exits non-zero; that's expected.
  const stderr = await new Promise<string>((resolve) =>
    execFile(FFMPEG(), ["-hide_banner", "-i", path], { windowsHide: true }, (_e, _o, err) => resolve(String(err))),
  );
  const match = /Stream[^\n]*Video[^\n]*?,\s(\d{2,5})x(\d{2,5})/.exec(stderr);
  if (!match) throw new Error("ffmpeg couldn't read the video size.");
  return { width: Number(match[1]), height: Number(match[2]) };
}

/** Dark runs [start, end] (inclusive) in a profile. */
function darkRuns(profile: number[]) {
  const runs: [number, number][] = [];
  let start = -1;
  profile.forEach((value, i) => {
    if (value < DARK && start < 0) start = i;
    if ((value >= DARK || i === profile.length - 1) && start >= 0) {
      runs.push([start, value < DARK ? i : i - 1]);
      start = -1;
    }
  });
  return runs;
}

/** Splits [0, size) into tiles at gutter runs inside the middle band, trimming dark edges. */
function intervals(profile: number[]): [number, number][] {
  const size = profile.length;
  const runs = darkRuns(profile);
  let lo = 0;
  let hi = size - 1;
  for (const [a, b] of runs) {
    if (a === 0) lo = b + 1;
    if (b === size - 1) hi = a - 1;
  }
  // Gutters are thin (under 3 % of the frame) and away from the edges.
  const gutters = runs.filter(([a, b]) => a > lo + size * 0.2 && b < hi - size * 0.2 && b - a + 1 <= Math.max(3, size * 0.03));
  const out: [number, number][] = [];
  let from = lo;
  for (const [a, b] of gutters) {
    out.push([from, a - 1]);
    from = b + 1;
  }
  out.push([from, hi]);
  return out;
}

const NAMES_2x2 = ["top-left", "top-right", "bottom-left", "bottom-right"];

/** Finds the camera tiles in a video. One tile = not a grid. */
export async function detectGrid(path: string, durationS: number | null): Promise<GridSplit> {
  const { width, height } = await dimensions(path);
  // Average three frames spread through the clip, so a dark car or shadow can't fake a gutter.
  const times = durationS ? [0.2, 0.5, 0.8].map((k) => k * durationS) : [1, 3, 5];
  const cols = new Float64Array(width);
  const rows = new Float64Array(height);
  let frames = 0;
  for (const t of times) {
    const { stdout } = await run(["-v", "error", "-ss", t.toFixed(2), "-i", path, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "gray", "-"]);
    if (stdout.length < width * height) continue;
    frames++;
    for (let y = 0; y < height; y++) {
      let sum = 0;
      for (let x = 0; x < width; x++) {
        const v = stdout[y * width + x]!;
        sum += v;
        cols[x] += v / height;
      }
      rows[y] += sum / width;
    }
  }
  if (!frames) throw new Error("ffmpeg couldn't read frames from the video.");
  const xs = intervals([...cols].map((v) => v / frames));
  const ys = intervals([...rows].map((v) => v / frames));
  const tiles: Tile[] = [];
  ys.forEach(([y0, y1], r) =>
    xs.forEach(([x0, x1], c) => {
      // libx264 needs even sizes.
      const w = (x1 - x0 + 1) & ~1;
      const h = (y1 - y0 + 1) & ~1;
      if (w < MIN_TILE.w || h < MIN_TILE.h) return;
      const label = xs.length === 2 && ys.length === 2 ? NAMES_2x2[r * 2 + c]! : `row ${r + 1}, column ${c + 1}`;
      tiles.push({ label, crop: { x: x0, y: y0, w, h } });
    }),
  );
  if (tiles.length < 2) return { tiles: [], width, height };
  return { tiles, width, height };
}

/** Crops one tile into its own clip (cached by source hash + crop). Returns the file path. */
export async function cropTile(path: string, sourceSha: string, tile: Tile, cacheDir: string) {
  const { x, y, w, h } = tile.crop;
  const key = createHash("sha256").update(`${sourceSha}|${x},${y},${w},${h}`).digest("hex").slice(0, 16);
  const out = join(cacheDir, `${key}.mp4`);
  if (existsSync(out)) return out;
  await fs.mkdir(cacheDir, { recursive: true });
  const tmp = `${out}.part.mp4`;
  await run(["-v", "error", "-y", "-i", path, "-vf", `crop=${w}:${h}:${x}:${y}`, "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-an", tmp]);
  await fs.rename(tmp, out);
  return out;
}
