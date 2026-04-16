"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { AudioWaveform } from "./audio-waveform/audio-waveform";
import {
  DEFAULT_REPRO_FEATURES,
  formatFeaturesForLog,
  isIos,
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

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/**
 * Minimal repro matching the production voice path:
 * getUserMedia → AudioContext → MediaStreamSource → AnalyserNode (2048, smoothing 0.3) + MediaRecorder (1s timeslice for visible chunks).
 * Leave recording running to test iOS Safari tab crashes (~1 min).
 *
 * Mitigation toggles allow testing various strategies to prevent crashes.
 */
export function AudioCrashRepro() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [elapsedSec, setElapsedSec] = useState(0);
  const [chunksTotalBytes, setChunksTotalBytes] = useState(0);
  const [chunkCount, setChunkCount] = useState(0);
  const [restartCount, setRestartCount] = useState(0);
  const [analyserNode, setAnalyserNode] = useState<AnalyserNode | null>(null);
  const [sourceNode, setSourceNode] = useState<MediaStreamAudioSourceNode | null>(null);
  const [features, setFeatures] = useState<ReproFeatures>(DEFAULT_REPRO_FEATURES);

  const streamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const restartTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const ctxRecreateTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startedAtRef = useRef<number | null>(null);
  const currentRunIdRef = useRef<string | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const featuresRef = useRef<ReproFeatures>(DEFAULT_REPRO_FEATURES);
  const restartCountRef = useRef(0);

  const [runs, setRuns] = useState<RecordingRun[]>([]);

  useEffect(() => {
    setRuns(reconcileRunsAfterReload());
  }, []);

  useEffect(() => {
    const loaded = loadFeatureToggles();
    setFeatures(loaded);
    featuresRef.current = loaded;
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

  const patchFeature = useCallback(<K extends keyof ReproFeatures>(key: K, value: ReproFeatures[K]) => {
    setFeatures((prev) => {
      const next = { ...prev, [key]: value };
      saveFeatureToggles(next);
      featuresRef.current = next;
      return next;
    });
  }, []);

  const refreshRuns = useCallback(() => {
    setRuns(sortedRunsNewestFirst(loadRuns()));
  }, []);

  // ── Determine effective waveform behavior ────────────────────────────
  const shouldSkipAnalyser = features.skipAnalyserOnIos && isIos();
  const effectiveWaveform = features.waveform && !shouldSkipAnalyser;

  // ── Core helpers ─────────────────────────────────────────────────────

  const createAudioContext = useCallback((): AudioContext => {
    const AudioContextClass =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    return new AudioContextClass();
  }, []);

  const setupAudioGraph = useCallback(
    (ctx: AudioContext, stream: MediaStream, wantAnalyser: boolean) => {
      const src = ctx.createMediaStreamSource(stream);
      sourceRef.current = src;
      setSourceNode(src);

      if (wantAnalyser) {
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 2048;
        analyser.smoothingTimeConstant = 0.3;
        analyserRef.current = analyser;
        setAnalyserNode(analyser);

        // If using disconnect-between-samples, start disconnected — the
        // waveform component will connect/disconnect on each sample.
        if (!featuresRef.current.analyserDisconnectBetweenSamples) {
          src.connect(analyser);
        }
      } else {
        analyserRef.current = null;
        setAnalyserNode(null);
      }
    },
    [],
  );

  const teardownAudioGraph = useCallback(() => {
    if (sourceRef.current) {
      try {
        sourceRef.current.disconnect();
      } catch {
        /* noop */
      }
      sourceRef.current = null;
      setSourceNode(null);
    }
    if (analyserRef.current) {
      try {
        analyserRef.current.disconnect();
      } catch {
        /* noop */
      }
      analyserRef.current = null;
      setAnalyserNode(null);
    }
  }, []);

  const cleanup = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    if (restartTimerRef.current) {
      clearInterval(restartTimerRef.current);
      restartTimerRef.current = null;
    }
    if (ctxRecreateTimerRef.current) {
      clearInterval(ctxRecreateTimerRef.current);
      ctxRecreateTimerRef.current = null;
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

    teardownAudioGraph();

    const ctx = audioContextRef.current;
    if (ctx) {
      void ctx.close();
    }
    audioContextRef.current = null;
  }, [teardownAudioGraph]);

  // Use a ref so the unmount effect always calls the latest cleanup without
  // re-firing (and accidentally stopping a live recording) when the callback
  // identity changes due to dependency updates.
  const cleanupRef = useRef(cleanup);
  cleanupRef.current = cleanup;

  useEffect(() => () => cleanupRef.current(), []);

  // ── MediaRecorder restart cycle ──────────────────────────────────────
  // Start the new recorder *before* stopping the old one so that both
  // briefly record from the same MediaStream. This eliminates the gap
  // where samples would otherwise be dropped between stop→start. The
  // overlap is typically < 1 ms (just two synchronous JS calls) so the
  // duplicate data is negligible and can be trimmed when stitching.

  const restartMediaRecorder = useCallback(() => {
    const stream = streamRef.current;
    if (!stream) return;

    const oldMr = mediaRecorderRef.current;

    // 1. Create and start the new recorder first — it begins capturing
    //    from the live stream immediately.
    const newRecorder = new MediaRecorder(stream);
    mediaRecorderRef.current = newRecorder;

    newRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) {
        chunksRef.current.push(e.data);
        setChunkCount(chunksRef.current.length);
        setChunksTotalBytes(chunksRef.current.reduce((acc, b) => acc + b.size, 0));
      }
    };
    newRecorder.onstop = () => {};
    newRecorder.start(1000);

    // 2. Now stop the old recorder — its final ondataavailable fires
    //    asynchronously, so the new one is already covering the stream.
    if (oldMr && oldMr.state === "recording") {
      oldMr.stop();
    }

    // Release accumulated chunks to free memory
    if (featuresRef.current.releaseChunks) {
      chunksRef.current = [];
    }

    restartCountRef.current += 1;
    setRestartCount(restartCountRef.current);
    console.info(`[ios-audio-repro] MediaRecorder restarted (cycle #${restartCountRef.current})`);
  }, []);

  // ── AudioContext recreation cycle ────────────────────────────────────
  // Closes the current AudioContext and creates a fresh one to release
  // accumulated GPU/audio process resources.

  const recreateAudioContext = useCallback(() => {
    const stream = streamRef.current;
    if (!stream) return;

    // Tear down old graph
    teardownAudioGraph();
    const oldCtx = audioContextRef.current;
    if (oldCtx) {
      void oldCtx.close();
    }

    // Build fresh context + graph
    const newCtx = createAudioContext();
    audioContextRef.current = newCtx;

    if (newCtx.state === "suspended") {
      void newCtx.resume();
    }

    setupAudioGraph(newCtx, stream, effectiveWaveform);
    console.info("[ios-audio-repro] AudioContext recreated");
  }, [createAudioContext, setupAudioGraph, teardownAudioGraph, effectiveWaveform]);

  // ── Start / Stop ─────────────────────────────────────────────────────

  const start = async () => {
    setError(null);
    cleanup();
    restartCountRef.current = 0;
    setRestartCount(0);

    const featureSnapshot: ReproFeatures = { ...features };

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const wantAnalyser = featureSnapshot.waveform && !(featureSnapshot.skipAnalyserOnIos && isIos());

      if (wantAnalyser || featureSnapshot.audioContextRecreate) {
        const ctx = createAudioContext();
        audioContextRef.current = ctx;

        if (ctx.state === "suspended") {
          await ctx.resume();
        }

        setupAudioGraph(ctx, stream, wantAnalyser);
      }

      chunksRef.current = [];
      const recorder = new MediaRecorder(stream);
      mediaRecorderRef.current = recorder;

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) {
          chunksRef.current.push(e.data);
          setChunkCount(chunksRef.current.length);
          setChunksTotalBytes(chunksRef.current.reduce((acc, b) => acc + b.size, 0));
        }
      };

      recorder.onstop = () => {};

      startedAtRef.current = Date.now();
      setElapsedSec(0);
      setChunksTotalBytes(0);
      setChunkCount(0);

      recorder.start(1000);
      setPhase("recording");

      console.info(
        "[ios-audio-repro] recording started · features:",
        featureSnapshot,
        formatFeaturesForLog(featureSnapshot),
      );

      const run = appendRunningRun(featureSnapshot);
      currentRunIdRef.current = run.id;
      refreshRuns();

      // Elapsed timer
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

      // MediaRecorder restart cycle
      if (featureSnapshot.recorderRestartCycle && featureSnapshot.recorderRestartIntervalSec > 0) {
        restartTimerRef.current = setInterval(
          restartMediaRecorder,
          featureSnapshot.recorderRestartIntervalSec * 1000,
        );
      }

      // AudioContext recreation cycle
      if (featureSnapshot.audioContextRecreate && featureSnapshot.audioContextRecreateIntervalSec > 0) {
        ctxRecreateTimerRef.current = setInterval(
          recreateAudioContext,
          featureSnapshot.audioContextRecreateIntervalSec * 1000,
        );
      }
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

  // ── Render ───────────────────────────────────────────────────────────

  return (
    <div className="mx-auto flex max-w-lg flex-col gap-4 p-6 font-sans">
      <h1 className="text-xl font-semibold tracking-tight">iOS Safari audio repro</h1>
      <p className="text-sm text-zinc-600 dark:text-zinc-400">
        Mirrors production: mic → optional Web Audio analyser + MediaRecorder. Add iframe / Motion stressors to test
        whether total memory pressure speeds up death. Feature flags persist; each run records which stressors were on.
      </p>

      {/* ── Stressors ─────────────────────────────────────────────── */}
      <fieldset className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-700">
        <legend className="px-1 text-xs font-medium text-zinc-600 dark:text-zinc-400">Stressors</legend>
        <div className="flex flex-col gap-2 text-sm">
          <ToggleRow label="Waveform (Analyser + bars)" checked={features.waveform} disabled={togglesLocked} onChange={(v) => patchFeature("waveform", v)} />
          <ToggleRow label="Heavy iframe (same-origin /heavy-embed)" checked={features.heavyIframe} disabled={togglesLocked} onChange={(v) => patchFeature("heavyIframe", v)} />
          <ToggleRow label="R3F iframe (same-origin /r3f-embed · WebGL)" checked={features.r3fIframe} disabled={togglesLocked} onChange={(v) => patchFeature("r3fIframe", v)} />
          <ToggleRow label="Motion loop (motion/react)" checked={features.motionLoop} disabled={togglesLocked} onChange={(v) => patchFeature("motionLoop", v)} />
          <ToggleRow label="MutationObserver on <html> (subtree + attrs + text + oldValues)" checked={features.mutationObserverAll} disabled={togglesLocked} onChange={(v) => patchFeature("mutationObserverAll", v)} />
        </div>
        <p className="mt-2 font-mono text-[11px] text-zinc-500 dark:text-zinc-400">
          Active now: {formatFeaturesForLog(features)}
        </p>
      </fieldset>

      {/* ── Mitigations ───────────────────────────────────────────── */}
      <fieldset className="rounded-lg border border-blue-200 p-3 dark:border-blue-800">
        <legend className="px-1 text-xs font-medium text-blue-600 dark:text-blue-400">Mitigations</legend>
        <div className="flex flex-col gap-3 text-sm">
          {/* Recorder restart */}
          <div className="flex flex-col gap-1">
            <ToggleRow
              label="Periodic MediaRecorder stop/restart"
              checked={features.recorderRestartCycle}
              disabled={togglesLocked}
              onChange={(v) => patchFeature("recorderRestartCycle", v)}
            />
            {features.recorderRestartCycle && (
              <NumberInput
                label="Interval (seconds)"
                value={features.recorderRestartIntervalSec}
                min={5}
                max={300}
                disabled={togglesLocked}
                onChange={(v) => patchFeature("recorderRestartIntervalSec", v)}
              />
            )}
          </div>

          {/* Release chunks */}
          <ToggleRow
            label="Release chunk blobs on restart (free memory)"
            checked={features.releaseChunks}
            disabled={togglesLocked}
            onChange={(v) => patchFeature("releaseChunks", v)}
          />

          {/* Waveform FPS cap */}
          <div className="flex flex-col gap-1">
            <label className="flex cursor-pointer items-center gap-2">
              <input
                type="checkbox"
                checked={features.waveformFpsCap > 0}
                disabled={togglesLocked}
                onChange={(e) => patchFeature("waveformFpsCap", e.target.checked ? 10 : 0)}
              />
              <span>Throttle waveform FPS (rAF cap)</span>
            </label>
            {features.waveformFpsCap > 0 && (
              <NumberInput
                label="Target FPS"
                value={features.waveformFpsCap}
                min={1}
                max={60}
                disabled={togglesLocked}
                onChange={(v) => patchFeature("waveformFpsCap", v)}
              />
            )}
          </div>

          {/* Analyser disconnect between samples */}
          <ToggleRow
            label="Disconnect AnalyserNode between samples"
            checked={features.analyserDisconnectBetweenSamples}
            disabled={togglesLocked}
            onChange={(v) => patchFeature("analyserDisconnectBetweenSamples", v)}
          />

          {/* Skip analyser on iOS */}
          <div className="flex flex-col gap-0.5">
            <ToggleRow
              label="Skip AnalyserNode on iOS (pulsing dot instead)"
              checked={features.skipAnalyserOnIos}
              disabled={togglesLocked}
              onChange={(v) => patchFeature("skipAnalyserOnIos", v)}
            />
            <span className="pl-6 text-[11px] text-zinc-400">
              {isIos() ? "iOS detected — will skip" : "Not iOS — toggle has no effect here"}
            </span>
          </div>

          {/* AudioContext recreation */}
          <div className="flex flex-col gap-1">
            <ToggleRow
              label="Periodic AudioContext close + recreate"
              checked={features.audioContextRecreate}
              disabled={togglesLocked}
              onChange={(v) => patchFeature("audioContextRecreate", v)}
            />
            {features.audioContextRecreate && (
              <NumberInput
                label="Interval (seconds)"
                value={features.audioContextRecreateIntervalSec}
                min={10}
                max={600}
                disabled={togglesLocked}
                onChange={(v) => patchFeature("audioContextRecreateIntervalSec", v)}
              />
            )}
          </div>
        </div>
      </fieldset>

      {/* ── Stressor embeds ───────────────────────────────────────── */}
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

      {/* ── Waveform / placeholder ────────────────────────────────── */}
      <div className="h-14 w-full text-zinc-900 dark:text-zinc-100">
        {effectiveWaveform ? (
          <AudioWaveform
            analyser={analyserNode}
            sourceNode={sourceNode}
            fpsCap={features.waveformFpsCap}
            disconnectBetweenSamples={features.analyserDisconnectBetweenSamples}
            className="h-full w-full"
          />
        ) : shouldSkipAnalyser ? (
          <div className="flex h-full items-center justify-center rounded-md border border-dashed border-blue-300 px-2 text-xs text-blue-500 dark:border-blue-700 dark:text-blue-400">
            <PulsingDot active={phase === "recording"} />
            <span className="ml-2">iOS mode — AnalyserNode skipped (MediaRecorder only)</span>
          </div>
        ) : (
          <div className="flex h-full items-center rounded-md border border-dashed border-zinc-300 px-2 text-xs text-zinc-500 dark:border-zinc-600 dark:text-zinc-400">
            Waveform off — no AudioContext / Analyser (MediaRecorder only).
          </div>
        )}
      </div>

      {/* ── Controls ──────────────────────────────────────────────── */}
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

      {/* ── Stats ─────────────────────────────────────────────────── */}
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-zinc-500">Status</dt>
        <dd className="font-mono">{phase}</dd>
        <dt className="text-zinc-500">Elapsed</dt>
        <dd className="font-mono">{formatElapsed(elapsedSec)}</dd>
        <dt className="text-zinc-500">Chunks (1s timeslice)</dt>
        <dd className="font-mono">
          {chunkCount} ({formatBytes(chunksTotalBytes)})
        </dd>
        {features.recorderRestartCycle && (
          <>
            <dt className="text-zinc-500">Recorder restarts</dt>
            <dd className="font-mono">{restartCount}</dd>
          </>
        )}
      </dl>

      {error ? <p className="text-sm text-red-600 dark:text-red-400">{error}</p> : null}

      {/* ── Run history ───────────────────────────────────────────── */}
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

// ── Small helper components ──────────────────────────────────────────────

function ToggleRow({
  label,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  checked: boolean;
  disabled: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-2">
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  );
}

function NumberInput({
  label,
  value,
  min,
  max,
  disabled,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  disabled: boolean;
  onChange: (v: number) => void;
}) {
  return (
    <label className="flex items-center gap-2 pl-6 text-xs text-zinc-500 dark:text-zinc-400">
      {label}:
      <input
        type="number"
        className="w-16 rounded border border-zinc-300 bg-transparent px-1 py-0.5 text-xs dark:border-zinc-600"
        value={value}
        min={min}
        max={max}
        disabled={disabled}
        onChange={(e) => {
          const n = parseInt(e.target.value, 10);
          if (!isNaN(n) && n >= min && n <= max) onChange(n);
        }}
      />
    </label>
  );
}

function PulsingDot({ active }: { active: boolean }) {
  return (
    <span
      className={`inline-block size-3 rounded-full ${
        active ? "animate-pulse bg-red-500" : "bg-zinc-400"
      }`}
    />
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
