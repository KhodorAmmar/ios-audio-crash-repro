export type ReproFeatures = {
  waveform: boolean;
  heavyIframe: boolean;
  r3fIframe: boolean;
  motionLoop: boolean;
  /** document.documentElement + subtree + all mutation types (iOS repro). */
  mutationObserverAll: boolean;
};

const STORAGE_KEY = "ios-audio-repro-feature-toggles";

export const DEFAULT_REPRO_FEATURES: ReproFeatures = {
  waveform: true,
  heavyIframe: false,
  r3fIframe: false,
  motionLoop: false,
  mutationObserverAll: false,
};

function isRecord(x: unknown): x is Record<string, unknown> {
  return x !== null && typeof x === "object";
}

export function loadFeatureToggles(): ReproFeatures {
  if (typeof window === "undefined") return { ...DEFAULT_REPRO_FEATURES };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_REPRO_FEATURES };
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return { ...DEFAULT_REPRO_FEATURES };
    return {
      waveform: typeof parsed.waveform === "boolean" ? parsed.waveform : DEFAULT_REPRO_FEATURES.waveform,
      heavyIframe:
        typeof parsed.heavyIframe === "boolean" ? parsed.heavyIframe : DEFAULT_REPRO_FEATURES.heavyIframe,
      r3fIframe: typeof parsed.r3fIframe === "boolean" ? parsed.r3fIframe : DEFAULT_REPRO_FEATURES.r3fIframe,
      motionLoop: typeof parsed.motionLoop === "boolean" ? parsed.motionLoop : DEFAULT_REPRO_FEATURES.motionLoop,
      mutationObserverAll:
        typeof parsed.mutationObserverAll === "boolean"
          ? parsed.mutationObserverAll
          : DEFAULT_REPRO_FEATURES.mutationObserverAll,
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
  return on.length ? on.join(", ") : "(none)";
}
