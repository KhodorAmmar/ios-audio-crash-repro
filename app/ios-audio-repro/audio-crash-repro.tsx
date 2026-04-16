"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { AudioWaveform } from "./audio-waveform/audio-waveform";
import {
  DEFAULT_REPRO_FEATURES,
  formatFeaturesForLog,
  loadFeatureToggles,
  saveFeatureToggles,
  type ReproFeatures,
} from "./feature-toggles/feature-toggles";
import { MotionLooper } from "./motion-looper/motion-looper";
import {
  appendRunningRun,
  loadRuns,
  markRunDone,
  removeRun,
  reconcileRunsAfterReload,
  sortedRunsNewestFirst,
  updateRunElapsed,
  type RecordingRun,
} from "./recording-runs/recording-runs";

type Phase = "idle" | "recording" | "error";

function formatElapsed(totalSec: number): string {
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/**
 * Minimal repro matching the production voice path:
 * getUserMedia → AudioContext → MediaStreamSource → AnalyserNode (2048, smoothing 0.3) + MediaRecorder (1s timeslice for visible chunks).
 * Leave recording running to test iOS Safari tab crashes (~1 min).
 */
export function AudioCrashRepro() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [elapsedSec, setElapsedSec] = useState(0);
  const [chunksTotalBytes, setChunksTotalBytes] = useState(0);
  const [chunkCount, setChunkCount] = useState(0);
  const [analyserNode, setAnalyserNode] = useState<AnalyserNode | null>(null);
  const [features, setFeatures] = useState<ReproFeatures>(DEFAULT_REPRO_FEATURES);

  const streamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startedAtRef = useRef<number | null>(null);
  const currentRunIdRef = useRef<string | null>(null);

  const [runs, setRuns] = useState<RecordingRun[]>([]);

  useEffect(() => {
    setRuns(reconcileRunsAfterReload());
  }, []);

  useEffect(() => {
    setFeatures(loadFeatureToggles());
  }, []);

  useEffect(() => {
    if (!features.mutationObserverAll) {
      return;
    }
    const root = document.documentElement;
    const observer = new MutationObserver(() => {
      // Minimal callback — WebKit still delivers mutation records for the whole subtree.
    });
    observer.observe(root, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
      attributeOldValue: true,
      characterDataOldValue: true,
    });
    return () => {
      observer.disconnect();
    };
  }, [features.mutationObserverAll]);

  const togglesLocked = phase === "recording";

  const patchFeature = useCallback((key: keyof ReproFeatures, value: boolean) => {
    setFeatures((prev) => {
      const next = { ...prev, [key]: value };
      saveFeatureToggles(next);
      return next;
    });
  }, []);

  const refreshRuns = useCallback(() => {
    setRuns(sortedRunsNewestFirst(loadRuns()));
  }, []);

  const cleanup = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }

    const mr = mediaRecorderRef.current;
    if (mr && mr.state === "recording") {
      mr.ondataavailable = null;
      mr.onstop = null;
      mr.stop();
    }
    mediaRecorderRef.current = null;

    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;

    const ctx = audioContextRef.current;
    if (ctx) {
      void ctx.close();
    }
    audioContextRef.current = null;
    analyserRef.current = null;
    setAnalyserNode(null);
  }, []);

  useEffect(() => () => cleanup(), [cleanup]);

  const start = async () => {
    setError(null);
    cleanup();

    const featureSnapshot: ReproFeatures = {
      waveform: features.waveform,
      heavyIframe: features.heavyIframe,
      r3fIframe: features.r3fIframe,
      motionLoop: features.motionLoop,
      mutationObserverAll: features.mutationObserverAll,
    };

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      if (featureSnapshot.waveform) {
        const AudioContextClass =
          window.AudioContext ||
          (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        const ctx = new AudioContextClass();
        audioContextRef.current = ctx;

        if (ctx.state === "suspended") {
          await ctx.resume();
        }

        const analyser = ctx.createAnalyser();
        analyser.fftSize = 2048;
        analyser.smoothingTimeConstant = 0.3;
        analyserRef.current = analyser;
        setAnalyserNode(analyser);

        const source = ctx.createMediaStreamSource(stream);
        source.connect(analyser);
      } else {
        analyserRef.current = null;
        setAnalyserNode(null);
      }

      const chunks: Blob[] = [];
      const recorder = new MediaRecorder(stream);
      mediaRecorderRef.current = recorder;

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) {
          chunks.push(e.data);
          setChunkCount(chunks.length);
          setChunksTotalBytes(chunks.reduce((acc, b) => acc + b.size, 0));
        }
      };

      recorder.onstop = () => {
        // hold blobs until next start if needed for debugging
      };

      startedAtRef.current = Date.now();
      setElapsedSec(0);
      setChunksTotalBytes(0);
      setChunkCount(0);

      // `start()` with no timeslice often yields a single `dataavailable` when `stop()` runs, so chunk count stays 0
      // while recording. A timeslice forces periodic blobs (handy to confirm recording; slightly different from
      // one-shot buffering).
      recorder.start(1000);
      setPhase("recording");

      console.info("[ios-audio-repro] recording started · features:", featureSnapshot, formatFeaturesForLog(featureSnapshot));

      const run = appendRunningRun(featureSnapshot);
      currentRunIdRef.current = run.id;
      refreshRuns();

      timerRef.current = setInterval(() => {
        const t0 = startedAtRef.current;
        if (t0 == null) return;
        const sec = Math.floor((Date.now() - t0) / 1000);
        setElapsedSec(sec);
        const id = currentRunIdRef.current;
        if (id) {
          updateRunElapsed(id, sec);
          refreshRuns();
        }
      }, 500);
    } catch (e) {
      cleanup();
      setError(e instanceof Error ? e.message : String(e));
      setPhase("error");
    }
  };

  const stop = () => {
    const runId = currentRunIdRef.current;
    const t0 = startedAtRef.current;
    const finalSec = t0 != null ? Math.floor((Date.now() - t0) / 1000) : 0;

    cleanup();
    currentRunIdRef.current = null;

    if (runId) {
      markRunDone(runId, finalSec);
    }
    refreshRuns();
    setPhase("idle");
    startedAtRef.current = null;
  };

  return (
    <div className="mx-auto flex max-w-lg flex-col gap-4 p-6 font-sans">
      <h1 className="text-xl font-semibold tracking-tight">iOS Safari audio repro</h1>
      <p className="text-sm text-zinc-600 dark:text-zinc-400">
        Mirrors production: mic → optional Web Audio analyser + MediaRecorder. Add iframe / Motion stressors to test
        whether total memory pressure speeds up death. Feature flags persist; each run records which stressors were on.
      </p>

      <fieldset className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-700">
        <legend className="px-1 text-xs font-medium text-zinc-600 dark:text-zinc-400">Stressors</legend>
        <div className="flex flex-col gap-2 text-sm">
          <label className="flex cursor-pointer items-center gap-2">
            <input
              type="checkbox"
              checked={features.waveform}
              disabled={togglesLocked}
              onChange={(e) => patchFeature("waveform", e.target.checked)}
            />
            <span>Waveform (Analyser + bars)</span>
          </label>
          <label className="flex cursor-pointer items-center gap-2">
            <input
              type="checkbox"
              checked={features.heavyIframe}
              disabled={togglesLocked}
              onChange={(e) => patchFeature("heavyIframe", e.target.checked)}
            />
            <span>Heavy iframe (same-origin /heavy-embed)</span>
          </label>
          <label className="flex cursor-pointer items-center gap-2">
            <input
              type="checkbox"
              checked={features.r3fIframe}
              disabled={togglesLocked}
              onChange={(e) => patchFeature("r3fIframe", e.target.checked)}
            />
            <span>R3F iframe (same-origin /r3f-embed · WebGL)</span>
          </label>
          <label className="flex cursor-pointer items-center gap-2">
            <input
              type="checkbox"
              checked={features.motionLoop}
              disabled={togglesLocked}
              onChange={(e) => patchFeature("motionLoop", e.target.checked)}
            />
            <span>Motion loop (motion/react)</span>
          </label>
          <label className="flex cursor-pointer items-center gap-2">
            <input
              type="checkbox"
              checked={features.mutationObserverAll}
              disabled={togglesLocked}
              onChange={(e) => patchFeature("mutationObserverAll", e.target.checked)}
            />
            <span>MutationObserver on &lt;html&gt; (subtree + attrs + text + oldValues)</span>
          </label>
        </div>
        <p className="mt-2 font-mono text-[11px] text-zinc-500 dark:text-zinc-400">
          Active now: {formatFeaturesForLog(features)}
        </p>
      </fieldset>

      {features.motionLoop ? (
        <div className="rounded-lg border border-zinc-200 p-2 dark:border-zinc-700">
          <MotionLooper />
        </div>
      ) : null}

      {features.heavyIframe ? (
        <div className="overflow-hidden rounded-lg border border-zinc-200 dark:border-zinc-700">
          <iframe title="Heavy embed stress" className="h-48 w-full bg-zinc-100 dark:bg-zinc-900" src="/heavy-embed" />
        </div>
      ) : null}

      {features.r3fIframe ? (
        <div className="overflow-hidden rounded-lg border border-zinc-200 dark:border-zinc-700">
          <iframe title="React Three Fiber embed" className="h-56 w-full bg-zinc-950" src="/r3f-embed" />
        </div>
      ) : null}

      <div className="h-14 w-full text-zinc-900 dark:text-zinc-100">
        {features.waveform ? (
          <AudioWaveform analyser={analyserNode} className="h-full w-full" />
        ) : (
          <div className="flex h-full items-center rounded-md border border-dashed border-zinc-300 px-2 text-xs text-zinc-500 dark:border-zinc-600 dark:text-zinc-400">
            Waveform off — no AudioContext / Analyser (MediaRecorder only).
          </div>
        )}
      </div>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-40 dark:bg-zinc-100 dark:text-zinc-900"
          onClick={() => void start()}
          disabled={phase === "recording"}
        >
          Start recording
        </button>
        <button
          type="button"
          className="rounded-lg border border-zinc-300 px-4 py-2 text-sm font-medium dark:border-zinc-600"
          onClick={stop}
          disabled={phase !== "recording"}
        >
          Stop
        </button>
      </div>

      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-zinc-500">Status</dt>
        <dd className="font-mono">{phase}</dd>
        <dt className="text-zinc-500">Elapsed</dt>
        <dd className="font-mono">{formatElapsed(elapsedSec)}</dd>
        <dt className="text-zinc-500">Chunks (1s timeslice)</dt>
        <dd className="font-mono">
          {chunkCount} ({chunksTotalBytes} bytes)
        </dd>
      </dl>

      {error ? <p className="text-sm text-red-600 dark:text-red-400">{error}</p> : null}

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-medium text-zinc-700 dark:text-zinc-300">Runs</h2>
        <ul className="flex max-h-64 flex-col gap-2 overflow-y-auto rounded-lg border border-zinc-200 p-2 text-sm dark:border-zinc-700">
          {runs.length === 0 ? (
            <li className="text-zinc-500">No runs yet.</li>
          ) : (
            runs.map((run) => (
              <li
                key={run.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-zinc-50 px-2 py-1.5 dark:bg-zinc-900/50"
              >
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <span className="font-mono text-xs text-zinc-600 dark:text-zinc-400">
                    {run.id.slice(0, 8)} · {formatElapsed(run.lastElapsedSec)} ·{" "}
                    {new Date(run.startedAt).toLocaleString(undefined, {
                      month: "short",
                      day: "numeric",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </span>
                  {run.features ? (
                    <span className="font-mono text-[10px] text-zinc-500 dark:text-zinc-500">
                      {formatFeaturesForLog(run.features)}
                    </span>
                  ) : (
                    <span className="text-[10px] text-zinc-400">features: (legacy run)</span>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <RunBadge status={run.status} />
                  <button
                    type="button"
                    className="rounded px-1.5 py-0.5 text-xs text-zinc-500 underline decoration-zinc-400/80 underline-offset-2 hover:text-zinc-800 dark:hover:text-zinc-200"
                    aria-label={`Remove run ${run.id.slice(0, 8)}`}
                    onClick={() => {
                      if (!window.confirm("Remove this run?")) {
                        return;
                      }
                      removeRun(run.id);
                      refreshRuns();
                    }}
                  >
                    Remove
                  </button>
                </div>
              </li>
            ))
          )}
        </ul>
      </section>
    </div>
  );
}

function RunBadge({ status }: { status: RecordingRun["status"] }) {
  if (status === "done") {
    return (
      <span className="shrink-0 rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-800 dark:bg-emerald-900/50 dark:text-emerald-200">
        pass
      </span>
    );
  }
  if (status === "crashed") {
    return (
      <span className="shrink-0 rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-800 dark:bg-red-900/50 dark:text-red-200">
        crashed
      </span>
    );
  }
  return (
    <span className="shrink-0 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-900 dark:bg-amber-900/40 dark:text-amber-100">
      running
    </span>
  );
}
