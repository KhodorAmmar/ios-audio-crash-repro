# ios-audio-crash

Minimal **Next.js** harness to reproduce and bisect **iOS Safari tab crashes** when using the **microphone** with **`MediaRecorder`**, optional **Web Audio** (`AudioContext` → `AnalyserNode`), and optional “stress” toggles (iframes, animations, `MutationObserver`, etc.). It mirrors patterns from a larger app where recording sometimes died at a consistent wall-clock time while a lean repro was flaky—this page exists to **isolate variables** and **log what was enabled** per attempt.

## What to open on the phone

- **`/`** — short intro + link to the repro.
- **`/ios-audio-repro`** — main experiment: start/stop recording, elapsed time, optional waveform, stressors, and a **run history** backed by `localStorage`.

## Behavior

- **Recording path:** `getUserMedia({ audio: true })` → optionally `AudioContext` + analyser (when **Waveform** is on) → `MediaRecorder` with a **1s timeslice** so chunk counts update during recording.
- **Runs:** Each session appends a row with **elapsed seconds** (updated while recording). **Stop** marks the run **done** (green “pass”). If the tab **crashes or reloads** without Stop, any run left **running** is marked **crashed** on the next full page load.
- **Feature flags** are persisted (localStorage) and **snapshotted per run** so you can correlate crashes with toggles. The console also logs flags when recording starts.

## Stress toggles (all optional)

| Toggle | Effect |
|--------|--------|
| **Waveform** | `AnalyserNode` + bar visualizer (`getByteTimeDomainData` with a **reused** `Uint8Array`). Off = `MediaRecorder` only (no Web Audio graph). |
| **Heavy iframe** | Embeds same-origin **`/heavy-embed`** (large DOM grid). |
| **R3F iframe** | Embeds **`/r3f-embed`** (`@react-three/fiber` + WebGL scene). |
| **Motion loop** | `motion/react` always-on animation on the parent page. |
| **MutationObserver** | Observes **`document.documentElement`** with `subtree: true` and all relevant options (incl. old values); empty callback—cost is mainly mutation delivery on busy documents. |

Supporting routes: **`/heavy-embed`**, **`/r3f-embed`** (inside iframes or standalone).

## Development

```bash
pnpm install
pnpm dev
```

Then open [http://localhost:3000/ios-audio-repro](http://localhost:3000/ios-audio-repro) (use your LAN URL on a real iPhone).

```bash
pnpm build
pnpm lint
```

## Stack

Next.js (App Router), React, TypeScript, Tailwind, [`motion`](https://motion.dev), [`three`](https://threejs.org/) + [`@react-three/fiber`](https://docs.pmnd.rs/react-three-fiber) for the optional WebGL embed.

---

This repo is for **local / device experimentation**, not production voice features.
