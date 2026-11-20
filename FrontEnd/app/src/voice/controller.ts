/**
 * One dictation controller for the whole window, shared by every VoiceButton and the hotkey.
 *
 * Gestures follow Hex's "tap or hold" (https://github.com/anomalyco/hex, MIT; src/dictation.rs,
 * src/suppression/hotkey.rs): recording starts on the press itself, so no audio is lost waiting
 * to tell a tap from a hold. Released after HOLD_THRESHOLD_MS or more, it was push-to-talk and
 * finishes. Released sooner, it was a tap and keeps listening hands-free until the next press.
 * A finish keeps RELEASE_TAIL_MS more audio, because a release often lands on the last word.
 * Escape cancels. Silent clips are dropped quietly (main process side).
 */
import { MicError, MicRecorder } from "./recorder";
import type { EngineStatus, TranscribeResult, VoiceBackend, VoiceEvent, VoiceSink, VoiceSnapshot, VoiceView } from "./types";

const HOLD_THRESHOLD_MS = 300;
const RELEASE_TAIL_MS = 200;
const MAX_CAPTURE_MS = 120_000;
const PARTIAL_INTERVAL_MS = 1000;
const PARTIAL_MIN_MS = 800;
const PARTIAL_MAX_MS = 30_000;
/** A whole capture quieter than this (about -80 dBFS) means the mic delivers no signal. */
const DEAD_MIC_RMS = 1e-4;

type Stage = "starting" | "listening" | "finishing" | "transcribing";

type WebSpeechRun = { recognition: SpeechRecognitionLike; ended: Promise<void>; finalText: string; error?: string };

type Session = {
  sink: VoiceSink;
  pressedAt: number;
  /** The press that started the session is still down. */
  pressHeld: boolean;
  handsFree: boolean;
  stage: Stage;
  cancelled: boolean;
  finishRequested: boolean;
  timers: ReturnType<typeof setTimeout>[];
  partialInFlight: boolean;
  web?: WebSpeechRun;
};

// Minimal Web Speech API types (not in TypeScript's DOM lib).
type SpeechRecognitionAlternativeLike = { transcript: string };
type SpeechRecognitionResultLike = { isFinal: boolean; length: number; [index: number]: SpeechRecognitionAlternativeLike };
type SpeechRecognitionEventLike = { results: { length: number; [index: number]: SpeechRecognitionResultLike } };
type SpeechRecognitionLike = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
};
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function voiceBridge() {
  try {
    return typeof window !== "undefined" ? (window.crashvzn?.voice ?? null) : null;
  } catch {
    return null;
  }
}

function webSpeechCtor(): SpeechRecognitionCtor | null {
  try {
    const w = window as unknown as { SpeechRecognition?: SpeechRecognitionCtor; webkitSpeechRecognition?: SpeechRecognitionCtor };
    return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
  } catch {
    return null;
  }
}

/** Electron prefixes errors from ipcMain handlers; the user only needs the message. */
function plainMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^Error invoking remote method '[^']+': (?:\w*Error: )?/, "") || "Something went wrong.";
}

function webSpeechError(code: string): string | undefined {
  if (code === "no-speech" || code === "aborted") return undefined;
  if (code === "not-allowed" || code === "service-not-allowed") return "Microphone access is blocked for this page.";
  if (code === "audio-capture") return "No microphone found.";
  if (code === "network") return "Browser speech recognition needs an internet connection.";
  return "Speech recognition failed.";
}

const formatMb = (bytes: number) => `${Math.round(bytes / 1e6)} MB`;

export class VoiceController {
  private listeners = new Set<() => void>();
  private initialized = false;
  private backend: VoiceBackend = "none";
  private engine: EngineStatus | null = null;
  private session: Session | null = null;
  private recorder = new MicRecorder();
  private level = 0;
  private error: string | undefined;
  private defaultSinks: VoiceSink[] = [];
  private snapshot: VoiceSnapshot = {
    backend: "none",
    view: "unavailable",
    level: 0,
    handsFree: false,
    progress: 0,
    hint: "Voice input isn't available here.",
  };

  constructor() {
    this.recorder.onLevel = (rms) => {
      const db = 20 * Math.log10(Math.max(rms, 1e-6));
      const target = Math.min(1, Math.max(0, (db + 55) / 45));
      this.level = Math.max(target, this.level * 0.6);
      this.emit();
    };
  }

  private init() {
    if (this.initialized) return;
    this.initialized = true;
    const bridge = voiceBridge();
    if (bridge) {
      this.backend = "local";
      try {
        bridge.on((payload) => {
          const event = payload as VoiceEvent;
          if (event && event.type === "status") this.setEngine(event.status);
        });
        void (bridge.invoke("status") as Promise<EngineStatus>).then(
          (status) => {
            this.setEngine(status);
            // Load and warm the model in the background, as Hex does at launch.
            if (status.phase === "downloaded") void bridge.invoke("prepare").catch(() => {});
          },
          () => {
            this.backend = "none";
            this.emit();
          },
        );
      } catch {
        this.backend = "none";
      }
    } else if (webSpeechCtor()) {
      this.backend = "web-speech";
    }
    this.emit();
  }

  private setEngine(status: EngineStatus) {
    this.engine = status;
    this.emit();
  }

  subscribe = (listener: () => void) => {
    this.init();
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = () => this.snapshot;

  /** Where hotkey dictations go when the hook has no sink of its own: the newest mounted button. */
  addDefaultSink(sink: VoiceSink) {
    this.defaultSinks.push(sink);
    return () => {
      this.defaultSinks = this.defaultSinks.filter((s) => s !== sink);
    };
  }

  get defaultSink(): VoiceSink | null {
    return this.defaultSinks[this.defaultSinks.length - 1] ?? null;
  }

  isActive(sink?: VoiceSink) {
    return Boolean(this.session && (!sink || this.session.sink === sink));
  }

  private computeView(): VoiceView {
    const session = this.session;
    if (session) return session.stage === "transcribing" ? "transcribing" : "listening";
    if (this.backend === "none") return "unavailable";
    if (this.error) return "error";
    if (this.backend === "local" && this.engine) {
      if (this.engine.phase === "missing") return "needs-download";
      if (this.engine.phase === "downloading") return "downloading";
      if (this.engine.phase === "error") return "error";
    }
    return "idle";
  }

  private hintFor(view: VoiceView): string {
    const engine = this.engine;
    const size = engine ? formatMb(engine.total) : "";
    switch (view) {
      case "unavailable":
        return "Voice input needs the desktop app, or a browser with speech recognition.";
      case "needs-download":
        return `Click to download the speech model (${size}, one time). It runs on this computer.`;
      case "downloading":
        return `Downloading the speech model: ${Math.floor(this.progress() * 100)}% of ${size}. Click to cancel.`;
      case "listening":
        return this.session?.handsFree ? "Listening. Click or press again to stop, Esc to cancel." : "Listening. Release to stop, Esc to cancel.";
      case "transcribing":
        return "Transcribing…";
      case "error":
        return this.error ?? engine?.error ?? "Voice input failed.";
      default:
        if (this.backend === "local" && engine?.phase === "loading") return "Loading the speech model… You can start talking.";
        return "Click to dictate, or hold to talk.";
    }
  }

  private progress() {
    const engine = this.engine;
    return engine && engine.total > 0 ? Math.min(1, engine.received / engine.total) : 0;
  }

  private emit() {
    const view = this.computeView();
    this.snapshot = {
      backend: this.backend,
      view,
      level: view === "listening" ? this.level : 0,
      handsFree: Boolean(this.session?.handsFree),
      progress: this.progress(),
      hint: this.hintFor(view),
      error: view === "error" ? (this.error ?? this.engine?.error) : undefined,
    };
    for (const listener of this.listeners) listener();
  }

  // ----- gestures -----

  /**
   * A press of the button or the hotkey. `source: "key"` never starts or cancels a download,
   * which only a click on the button should do.
   */
  press(sink: VoiceSink | null, source: "pointer" | "key" = "pointer") {
    this.init();
    const session = this.session;
    if (session) {
      // In hands-free mode a fresh press finishes.
      if (session.handsFree && (session.stage === "starting" || session.stage === "listening")) void this.finish(session);
      return;
    }
    if (!sink || this.backend === "none") return;
    this.error = undefined;
    if (this.backend === "local") {
      const phase = this.engine?.phase;
      if (phase === "missing" || phase === "error") {
        if (source === "pointer") this.download();
        else this.emit();
        return;
      }
      if (phase === "downloading") {
        if (source === "pointer") this.cancelDownload();
        return;
      }
    }
    void this.begin(sink);
  }

  release() {
    const session = this.session;
    if (!session || !session.pressHeld) return;
    session.pressHeld = false;
    if (session.stage !== "starting" && session.stage !== "listening") return;
    if (performance.now() - session.pressedAt >= HOLD_THRESHOLD_MS) void this.finish(session);
    else {
      session.handsFree = true;
      this.emit();
    }
  }

  /** Discards the current capture (Esc). */
  cancel() {
    const session = this.session;
    if (!session || session.stage === "transcribing") return;
    session.cancelled = true;
    if (session.web) session.web.recognition.abort();
    else this.recorder.stop();
    session.sink.onPartial?.("");
    this.end(session);
  }

  download() {
    const bridge = voiceBridge();
    if (!bridge) return;
    this.error = undefined;
    void bridge.invoke("prepare").catch((error) => {
      const message = plainMessage(error);
      if (message !== "Download canceled") {
        this.error = message;
        this.emit();
      }
    });
  }

  cancelDownload() {
    void voiceBridge()?.invoke("cancelDownload").catch(() => {});
  }

  // ----- sessions -----

  private onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape" && this.session && this.session.stage !== "transcribing") {
      event.preventDefault();
      event.stopPropagation();
      this.cancel();
    }
  };

  /** A press held while the window loses focus never sees its release. */
  private onBlur = () => this.release();

  private async begin(sink: VoiceSink) {
    const session: Session = {
      sink,
      pressedAt: performance.now(),
      pressHeld: true,
      handsFree: false,
      stage: "starting",
      cancelled: false,
      finishRequested: false,
      timers: [],
      partialInFlight: false,
    };
    this.session = session;
    this.level = 0;
    window.addEventListener("keydown", this.onKeyDown, true);
    window.addEventListener("blur", this.onBlur);
    this.emit();
    try {
      if (this.backend === "web-speech") this.startWebSpeech(session);
      else {
        const bridge = voiceBridge();
        if (bridge) await bridge.invoke("requestMicAccess").catch(() => true);
        await this.recorder.start();
      }
    } catch (error) {
      this.fail(session, error instanceof MicError ? error.message : plainMessage(error));
      return;
    }
    if (session.cancelled) {
      // Canceled while the mic was opening: the recorder started after cancel() stopped it.
      if (!session.web) this.recorder.stop();
      return;
    }
    session.stage = "listening";
    session.timers.push(setTimeout(() => void this.finish(session), MAX_CAPTURE_MS));
    if (this.backend === "local" && sink.onPartial) session.timers.push(setInterval(() => this.partial(session), PARTIAL_INTERVAL_MS));
    this.emit();
    if (session.finishRequested) void this.finish(session);
  }

  private startWebSpeech(session: Session) {
    const Ctor = webSpeechCtor();
    if (!Ctor) throw new Error("Speech recognition isn't available in this browser.");
    const recognition = new Ctor();
    recognition.lang = "en-US";
    recognition.continuous = true;
    recognition.interimResults = true;
    let resolveEnded: () => void = () => {};
    const run: WebSpeechRun = { recognition, ended: new Promise<void>((resolve) => (resolveEnded = resolve)), finalText: "" };
    recognition.onresult = (event) => {
      let finalText = "";
      let interim = "";
      for (let i = 0; i < event.results.length; i++) {
        const result = event.results[i];
        if (result.isFinal) finalText += result[0].transcript;
        else interim += result[0].transcript;
      }
      run.finalText = finalText;
      if (!session.cancelled) session.sink.onPartial?.(`${finalText}${interim}`.trim());
    };
    recognition.onerror = (event) => {
      run.error = webSpeechError(event.error);
    };
    recognition.onend = () => {
      resolveEnded();
      // The browser ended it on its own (an error or a long pause): finish with what it has.
      if (this.session === session && (session.stage === "starting" || session.stage === "listening")) void this.finish(session);
    };
    session.web = run;
    recognition.start();
  }

  private partial(session: Session) {
    const bridge = voiceBridge();
    if (!bridge || session.stage !== "listening" || session.partialInFlight || !session.sink.onPartial) return;
    const audio = this.recorder.snapshot();
    const ms = (audio.length / this.recorder.sampleRate) * 1000;
    if (ms < PARTIAL_MIN_MS || ms > PARTIAL_MAX_MS) return;
    session.partialInFlight = true;
    (bridge.invoke("transcribe", audio, this.recorder.sampleRate, { partial: true }) as Promise<TranscribeResult>)
      .then((result) => {
        if (this.session === session && session.stage === "listening" && !session.cancelled && result.text) session.sink.onPartial?.(result.text);
      })
      .catch(() => {})
      .finally(() => {
        session.partialInFlight = false;
      });
  }

  private async finish(session: Session) {
    if (session.stage === "starting") {
      session.finishRequested = true;
      return;
    }
    if (session.stage !== "listening") return;
    session.stage = "finishing";
    this.emit();
    await sleep(RELEASE_TAIL_MS);
    if (session.cancelled) return;
    session.stage = "transcribing";
    this.emit();
    try {
      let text = "";
      if (session.web) {
        session.web.recognition.stop();
        await Promise.race([session.web.ended, sleep(4000)]);
        if (session.web.error) throw new Error(session.web.error);
        text = session.web.finalText.trim();
      } else {
        const rate = this.recorder.sampleRate;
        const audio = this.recorder.stop();
        if (audio.length >= rate * 0.5 && this.recorder.peakLevel < DEAD_MIC_RMS) {
          throw new Error("No sound from the microphone. Check that it isn't muted.");
        }
        const bridge = voiceBridge();
        if (!bridge) throw new Error("Voice input isn't available here.");
        if (audio.length > 0) {
          const result = (await bridge.invoke("transcribe", audio, rate, {})) as TranscribeResult;
          text = result.text;
        }
      }
      if (session.cancelled) return;
      session.sink.onPartial?.("");
      if (text) session.sink.onTranscript(text);
      this.end(session);
    } catch (error) {
      session.sink.onPartial?.("");
      this.fail(session, plainMessage(error));
    }
  }

  private fail(session: Session, message: string) {
    if (session.web) session.web.recognition.abort();
    else this.recorder.stop();
    this.error = message;
    this.end(session);
  }

  private end(session: Session) {
    session.timers.forEach((timer) => clearTimeout(timer));
    session.timers = [];
    if (this.session !== session) return;
    this.session = null;
    this.level = 0;
    window.removeEventListener("keydown", this.onKeyDown, true);
    window.removeEventListener("blur", this.onBlur);
    this.emit();
  }
}

let shared: VoiceController | null = null;

export function voiceController(): VoiceController {
  shared ??= new VoiceController();
  return shared;
}
