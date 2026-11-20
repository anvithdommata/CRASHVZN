/**
 * Shared by every video-processing backend (codex-vision.ts, claude-vision.ts): turns the
 * Content-part style `parts` the analysis passes build into JPEG frame sheets on disk plus the
 * text prompt that describes them. Each sheet is a 2x2 grid of frames with their absolute
 * source-video timestamps spelled out in the prompt.
 */
import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

export type VisionPart = { text?: string; fileData?: { fileUri: string }; videoMetadata?: { fps?: number; startOffset?: string; endOffset?: string; duration?: number } };

/** Signature every backend implements: frames + schema + system prompt → structured JSON. */
export type GenerateVision = (
  parts: VisionPart[],
  schema: unknown,
  systemPrompt: string,
  onStatus?: (detail: string) => void,
) => Promise<{ json: unknown; usage: { model: string; auth: string; usage: unknown } }>;

/** Structured output requires closed objects, including nested nullable objects. */
export function strictSchema(value: any): any {
  if (Array.isArray(value)) return value.map(strictSchema);
  if (!value || typeof value !== "object") return value;
  const result = Object.fromEntries(Object.entries(value).map(([key, v]) => [key, strictSchema(v)]));
  if (result.properties) {
    result.additionalProperties = false;
    result.required = Object.keys(result.properties);
  }
  return result;
}

/** Bound images per request while covering the entire requested interval. */
export function samplePlan(from: number, to: number, fps: number, views: number) {
  if (![from, to, fps, views].every(Number.isFinite) || from < 0 || to <= from || fps <= 0 || views < 1) throw new Error("Invalid video sampling interval.");
  const count = Math.min(Math.ceil((to - from) * fps), Math.max(4, Math.floor(160 / views)));
  const rate = count / (to - from);
  return { count, rate, times: Array.from({ length: count }, (_, i) => from + i / rate) };
}

function ffmpeg(args: string[]) {
  return new Promise<void>((resolve, reject) => {
    execFile(process.env.FFMPEG_PATH || "ffmpeg", args, { windowsHide: true, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 }, (error, _out, stderr) => {
      if (error) reject(new Error(`Video frame extraction failed: ${stderr.slice(-1000) || error.message}`));
      else resolve();
    });
  });
}

export function footageDuration(path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    execFile(process.env.FFMPEG_PATH || "ffmpeg", ["-hide_banner", "-i", path], { windowsHide: true, timeout: 15_000 }, (_error, _out, stderr) => {
      const match = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr);
      const seconds = match ? Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) : 0;
      if (seconds > 0) resolve(seconds);
      else reject(new Error("Couldn't read the footage duration. Check the file and ffmpeg installation."));
    });
  });
}

/**
 * Extracts the frame sheets for every video part into `dir`.
 * Returns the sheet paths (in prompt order) and the prompt paragraphs; each sheet's
 * paragraph starts "Image N:" so the model can tie it to the Nth attached image.
 */
export async function prepareFrameSheets(parts: VisionPart[], dir: string, modelLabel: string, onStatus?: (detail: string) => void) {
  const images: string[] = [];
  const prompt: string[] = [];
  const views = parts.filter((p) => p.fileData).length;
  for (const [index, part] of parts.entries()) {
    if (part.text) prompt.push(part.text);
    if (!part.fileData) continue;
    const meta = part.videoMetadata ?? {};
    const from = Number.parseFloat(meta.startOffset ?? "0");
    const to = Number.parseFloat(meta.endOffset ?? String(meta.duration));
    const plan = samplePlan(from, to, meta.fps ?? 2, views);
    onStatus?.(`Preparing ${plan.count} frames for ${modelLabel} (${from.toFixed(1)}–${to.toFixed(1)} s)…`);
    const prefix = `view-${index}-`;
    await ffmpeg(["-hide_banner", "-loglevel", "error", "-y", "-ss", String(from), "-i", part.fileData.fileUri, "-t", String(to - from), "-vf",
      `fps=${plan.rate}:start_time=0:round=up,scale=768:432:force_original_aspect_ratio=decrease,pad=768:432:(ow-iw)/2:(oh-ih)/2,tile=2x2:nb_frames=4:padding=2:margin=2`,
      "-frames:v", String(Math.ceil(plan.count / 4)), join(dir, `${prefix}%03d.jpg`)]);
    const sheets = (await readdir(dir)).filter((name) => name.startsWith(prefix)).sort();
    if (!sheets.length) throw new Error("No frames could be extracted from the selected footage.");
    for (const [sheet, name] of sheets.entries()) {
      images.push(join(dir, name));
      prompt.push(`Image ${images.length}: frames in row-major order (top-left, top-right, bottom-left, bottom-right), source-video times ${plan.times.slice(sheet * 4, sheet * 4 + 4).map((t) => `${t.toFixed(3)} s`).join(", ")}. Any remaining cells are blank. Requested interval ${from}–${to} s; actual sampling ${plan.rate.toFixed(3)} fps. Use these absolute video timestamps, never sheet indices. Sampling can miss brief events; state uncertainty.`);
    }
  }
  return { images, prompt };
}
