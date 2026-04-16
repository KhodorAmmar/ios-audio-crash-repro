export type ReproFeatures = {
  waveform: boolean;
  heavyIframe: boolean;
  r3fIframe: boolean;
  motionLoop: boolean;
  /** document.documentElement + subtree + all mutation types (iOS repro). */
  mutationObserverAll: boolean;

  // ── Mitigations ──────────────────────────────────────────────────────
  /** Periodically stop + restart MediaRecorder to flush its internal buffer. */
  recorderRestartCycle: boolean;
  /** Seconds between stop/start cycles (default 30). */
  recorderRestartIntervalSec: number;
  /** Throttle waveform rAF to N fps instead of 60fps (0 = unthrottled). */
  waveformFpsCap: number;
  /** Disconnect AnalyserNode between samples instead of keeping it connected. */
  analyserDisconnectBetweenSamples: boolean;
  /** Skip AnalyserNode entirely on iOS — show a pulsing placeholder instead. */
  skipAnalyserOnIos: boolean;
  /** Periodically close and recreate AudioContext to release GPU/audio resources. */
  audioContextRecreate: boolean;
  /** Seconds between AudioContext recreation cycles (default 60). */
  audioContextRecreateIntervalSec: number;
  /** Release accumulated chunk blobs during recording to free memory. */
  releaseChunks: boolean;
};

const STORAGE_KEY = "ios-audio-repro-feature-toggles";

export const DEFAULT_REPRO_FEATURES: ReproFeatures = {
  waveform: true,
  heavyIframe: false,
  r3fIframe: false,
  motionLoop: false,
  mutationObserverAll: false,

  recorderRestartCycle: false,
  recorderRestartIntervalSec: 30,
  waveformFpsCap: 0,
  analyserDisconnectBetweenSamples: false,
  skipAnalyserOnIos: false,
  audioContextRecreate: false,
  audioContextRecreateIntervalSec: 60,
  releaseChunks: false,
};

function isRecord(x: unknown): x is Record<string, unknown> {
  return x !== null && typeof x === "object";
}

function readBool(parsed: Record<string, unknown>, key: string): boolean {
  return typeof parsed[key] === "boolean" ? (parsed[key] as boolean) : (DEFAULT_REPRO_FEATURES[key as keyof ReproFeatures] as boolean);
}

function readNum(parsed: Record<string, unknown>, key: string): number {
  return typeof parsed[key] === "number" ? (parsed[key] as number) : (DEFAULT_REPRO_FEATURES[key as keyof ReproFeatures] as number);
}

export function loadFeatureToggles(): ReproFeatures {
  if (typeof window === "undefined") return { ...DEFAULT_REPRO_FEATURES };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_REPRO_FEATURES };
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return { ...DEFAULT_REPRO_FEATURES };
    return {
      waveform: readBool(parsed, "waveform"),
      heavyIframe: readBool(parsed, "heavyIframe"),
      r3fIframe: readBool(parsed, "r3fIframe"),
      motionLoop: readBool(parsed, "motionLoop"),
      mutationObserverAll: readBool(parsed, "mutationObserverAll"),

      recorderRestartCycle: readBool(parsed, "recorderRestartCycle"),
      recorderRestartIntervalSec: readNum(parsed, "recorderRestartIntervalSec"),
      waveformFpsCap: readNum(parsed, "waveformFpsCap"),
      analyserDisconnectBetweenSamples: readBool(parsed, "analyserDisconnectBetweenSamples"),
      skipAnalyserOnIos: readBool(parsed, "skipAnalyserOnIos"),
      audioContextRecreate: readBool(parsed, "audioContextRecreate"),
      audioContextRecreateIntervalSec: readNum(parsed, "audioContextRecreateIntervalSec"),
      releaseChunks: readBool(parsed, "releaseChunks"),
    };
  } catch {
    return { ...DEFAULT_REPRO_FEATURES };
  }
}

export function saveFeatureToggles(features: ReproFeatures): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(features));
}

export function formatFeaturesForLog(features: ReproFeatures): string {
  const on: string[] = [];
  if (features.waveform) on.push("waveform");
  if (features.heavyIframe) on.push("heavyIframe");
  if (features.r3fIframe) on.push("r3fIframe");
  if (features.motionLoop) on.push("motionLoop");
  if (features.mutationObserverAll) on.push("mutationObserverAll");

  if (features.recorderRestartCycle) on.push(`restart(${features.recorderRestartIntervalSec}s)`);
  if (features.waveformFpsCap > 0) on.push(`fpsCap(${features.waveformFpsCap})`);
  if (features.analyserDisconnectBetweenSamples) on.push("analyserDisconnect");
  if (features.skipAnalyserOnIos) on.push("skipAnalyserIOS");
  if (features.audioContextRecreate) on.push(`ctxRecreate(${features.audioContextRecreateIntervalSec}s)`);
  if (features.releaseChunks) on.push("releaseChunks");

  return on.length ? on.join(", ") : "(none)";
}

/** Rough iOS detection (used by skipAnalyserOnIos toggle). */
export function isIos(): boolean {
  if (typeof navigator === "undefined") return false;
  return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}
