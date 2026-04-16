import type { ReproFeatures } from "../feature-toggles/feature-toggles";

export type RunStatus = "running" | "done" | "crashed";

export interface RecordingRun {
  id: string;
  startedAt: number;
  /** Best-known elapsed seconds (updated while status is running). */
  lastElapsedSec: number;
  status: RunStatus;
  endedAt?: number;
  /** Feature flags at recording start (for crash experiments). */
  features?: ReproFeatures;
}

const STORAGE_KEY = "ios-audio-repro-runs";
const MAX_RUNS = 100;

function parseRuns(raw: string | null): RecordingRun[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out: RecordingRun[] = [];
    for (const item of parsed) {
      if (!isRecordingRun(item)) continue;
      const o = item as unknown as Record<string, unknown>;
      const features = o.features === undefined ? undefined : readFeatures(o.features);
      out.push({
        id: o.id as string,
        startedAt: o.startedAt as number,
        lastElapsedSec: o.lastElapsedSec as number,
        status: o.status as RunStatus,
        endedAt: typeof o.endedAt === "number" ? o.endedAt : undefined,
        features,
      });
    }
    return out;
  } catch {
    return [];
  }
}

/** Legacy runs may omit newer keys — defaults are backfilled. */
function readFeatures(x: unknown): ReproFeatures | undefined {
  if (x === null || typeof x !== "object") return undefined;
  const o = x as Record<string, unknown>;
  if (
    typeof o.waveform !== "boolean" ||
    typeof o.heavyIframe !== "boolean" ||
    typeof o.motionLoop !== "boolean"
  ) {
    return undefined;
  }
  if (o.r3fIframe !== undefined && typeof o.r3fIframe !== "boolean") return undefined;
  if (o.mutationObserverAll !== undefined && typeof o.mutationObserverAll !== "boolean") return undefined;

  const bool = (key: string, fallback: boolean) =>
    typeof o[key] === "boolean" ? (o[key] as boolean) : fallback;
  const num = (key: string, fallback: number) =>
    typeof o[key] === "number" ? (o[key] as number) : fallback;

  return {
    waveform: o.waveform,
    heavyIframe: o.heavyIframe,
    r3fIframe: bool("r3fIframe", false),
    motionLoop: o.motionLoop,
    mutationObserverAll: bool("mutationObserverAll", false),

    recorderRestartCycle: bool("recorderRestartCycle", false),
    recorderRestartIntervalSec: num("recorderRestartIntervalSec", 30),
    waveformFpsCap: num("waveformFpsCap", 0),
    analyserDisconnectBetweenSamples: bool("analyserDisconnectBetweenSamples", false),
    skipAnalyserOnIos: bool("skipAnalyserOnIos", false),
    audioContextRecreate: bool("audioContextRecreate", false),
    audioContextRecreateIntervalSec: num("audioContextRecreateIntervalSec", 60),
    releaseChunks: bool("releaseChunks", false),
  };
}

function isRecordingRun(x: unknown): x is RecordingRun {
  if (x === null || typeof x !== "object") return false;
  const o = x as Record<string, unknown>;
  if (
    typeof o.id !== "string" ||
    typeof o.startedAt !== "number" ||
    typeof o.lastElapsedSec !== "number" ||
    (o.status !== "running" && o.status !== "done" && o.status !== "crashed")
  ) {
    return false;
  }
  if (o.features !== undefined && readFeatures(o.features) === undefined) {
    return false;
  }
  return true;
}

export function loadRuns(): RecordingRun[] {
  if (typeof window === "undefined") return [];
  return parseRuns(localStorage.getItem(STORAGE_KEY));
}

function trimRuns(runs: RecordingRun[]): RecordingRun[] {
  if (runs.length <= MAX_RUNS) return runs;
  return [...runs].sort((a, b) => b.startedAt - a.startedAt).slice(0, MAX_RUNS);
}

export function saveRuns(runs: RecordingRun[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(trimRuns(runs)));
}

/**
 * On full page load, any run still `running` was not stopped cleanly → mark `crashed`.
 */
export function reconcileRunsAfterReload(): RecordingRun[] {
  const loaded = loadRuns();
  const now = Date.now();
  let changed = false;
  const next = loaded.map((r) => {
    if (r.status !== "running") return r;
    changed = true;
    return { ...r, status: "crashed" as const, endedAt: now };
  });
  if (changed) saveRuns(next);
  return sortedRunsNewestFirst(next);
}

export function appendRunningRun(features: ReproFeatures): RecordingRun {
  const run: RecordingRun = {
    id: crypto.randomUUID(),
    startedAt: Date.now(),
    lastElapsedSec: 0,
    status: "running",
    features: { ...features },
  };
  const runs = [...loadRuns(), run];
  saveRuns(runs);
  return run;
}

export function updateRunElapsed(id: string, lastElapsedSec: number): void {
  const runs = loadRuns();
  const idx = runs.findIndex((r) => r.id === id);
  if (idx === -1) return;
  runs[idx] = { ...runs[idx], lastElapsedSec };
  saveRuns(runs);
}

export function markRunDone(id: string, lastElapsedSec: number): void {
  const runs = loadRuns();
  const idx = runs.findIndex((r) => r.id === id);
  if (idx === -1) return;
  runs[idx] = {
    ...runs[idx],
    status: "done",
    lastElapsedSec,
    endedAt: Date.now(),
  };
  saveRuns(runs);
}

export function removeRun(id: string): void {
  const runs = loadRuns().filter((r) => r.id !== id);
  saveRuns(runs);
}

export function sortedRunsNewestFirst(runs: RecordingRun[]): RecordingRun[] {
  return [...runs].sort((a, b) => b.startedAt - a.startedAt);
}
