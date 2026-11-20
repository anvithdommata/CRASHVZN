/**
 * Video-processing ("processor") providers. Only subscription logins through each vendor's
 * own CLI are allowed here, never API keys:
 *   codex  → OpenAI via Codex CLI on the user's ChatGPT login (codex-vision.ts)
 *   claude → Claude via Claude Code on the user's Claude subscription login (claude-vision.ts)
 * The active one is chosen on the Providers page and stored in app settings.
 */
import { CLAUDE_VISION_DEFAULT_MODEL, CLAUDE_VISION_MODELS, claudeGenerateVision, claudeVisionPreflight } from "./claude-vision";
import { generateVision as codexGenerateVision, visionPreflight as codexPreflight, VISION_MODEL as CODEX_VISION_MODEL } from "./codex-vision";
import type { GenerateVision } from "./vision-frames";

export type ProcessorKind = "codex" | "claude";
export type ProcessorChoice = { provider: ProcessorKind; model?: string };

export type ProcessorInfo = {
  provider: ProcessorKind;
  /** Name used in progress messages ("Codex is reading…"). */
  name: string;
  label: string;
  detail: string;
  /** The CLI this runs through (its health comes from the chat provider check of the same CLI). */
  cli: "codex" | "claude";
  models: string[];
  defaultModel: string;
  effort: string;
  /** Which signed-in account kinds count; any other login is "signed in, but not usable here". */
  requires: RegExp;
  requiresText: string;
};

export const PROCESSORS: ProcessorInfo[] = [
  {
    provider: "codex",
    name: "Codex",
    label: "OpenAI · Codex CLI",
    detail: "Frame sheets read by OpenAI through your ChatGPT login.",
    cli: "codex",
    models: [CODEX_VISION_MODEL],
    defaultModel: CODEX_VISION_MODEL,
    effort: "xhigh",
    requires: /chatgpt/i,
    requiresText: "a ChatGPT login (`codex login`), not an API key",
  },
  {
    provider: "claude",
    name: "Claude",
    label: "Claude · Claude Code",
    detail: "Frame sheets read by Claude through your Claude subscription login.",
    cli: "claude",
    models: CLAUDE_VISION_MODELS,
    defaultModel: CLAUDE_VISION_DEFAULT_MODEL,
    effort: "high",
    requires: /^Claude\s/,
    requiresText: "a Claude subscription login (`claude auth login`), not an API key",
  },
];

export const DEFAULT_PROCESSOR: ProcessorChoice = { provider: "codex" };

export function processorInfo(provider: string | undefined): ProcessorInfo {
  return PROCESSORS.find((p) => p.provider === provider) ?? PROCESSORS[0]!;
}

/** The backend for a choice: model resolved, preflight and generate bound to it. */
export function resolveProcessor(choice: ProcessorChoice) {
  const info = processorInfo(choice.provider);
  const model = choice.model && info.models.includes(choice.model) ? choice.model : info.defaultModel;
  const preflight = info.provider === "claude" ? () => claudeVisionPreflight(model) : codexPreflight;
  const generate: GenerateVision =
    info.provider === "claude"
      ? (parts, schema, systemPrompt, onStatus) => claudeGenerateVision(parts, schema, systemPrompt, onStatus, model)
      : codexGenerateVision;
  return { ...info, model, preflight, generate };
}

/** A resolved backend: the provider's info plus the chosen model and functions bound to it. */
export type Processor = ReturnType<typeof resolveProcessor>;
