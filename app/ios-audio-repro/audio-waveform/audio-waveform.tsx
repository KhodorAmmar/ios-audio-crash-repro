"use client";

import { useEffect, useRef } from "react";

const BAR_WIDTH = 3;
const BAR_GAP = 2;
const MIN_HEIGHT = 0.1;
const ATTACK = 0.7;
const RELEASE = 0.06;
const SENSITIVITY = 1.8;

function cn(...parts: (string | undefined | false)[]): string {
  return parts.filter(Boolean).join(" ");
}

interface AudioWaveformProps {
  analyser: AnalyserNode | null;
  className?: string;
  /** Cap animation to N fps (0 = unthrottled ~60fps). */
  fpsCap?: number;
  /**
   * When true, disconnect the AnalyserNode from the audio graph between
   * samples and reconnect only to read data. Requires `sourceNode` so we
   * can call source.connect(analyser) / analyser.disconnect().
   */
  disconnectBetweenSamples?: boolean;
  sourceNode?: MediaStreamAudioSourceNode | null;
}

type WaveformState = {
  barCount: number;
  bars: HTMLDivElement[];
  heights: number[];
};

/**
 * Displays a bar waveform driven by an AnalyserNode. Bars are built imperatively for performance.
 */
export function AudioWaveform({
  analyser,
  className,
  fpsCap = 0,
  disconnectBetweenSamples = false,
  sourceNode = null,
}: AudioWaveformProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const stateRef = useRef<WaveformState | null>(null);
  if (stateRef.current === null) {
    stateRef.current = {
      barCount: 0,
      bars: [],
      heights: [],
    };
  }
  const state = stateRef.current;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const createBars = () => {
      const width = container.clientWidth;
      state.barCount = Math.max(1, Math.floor((width + BAR_GAP) / (BAR_WIDTH + BAR_GAP)));
      state.bars = Array.from({ length: state.barCount }, makeBar);
      state.heights = Array.from({ length: state.barCount }, () => MIN_HEIGHT);
      container.replaceChildren(...state.bars);
    };

    createBars();

    const resizeObserver = new ResizeObserver(createBars);
    resizeObserver.observe(container);

    return () => {
      resizeObserver.disconnect();
    };
  }, [state]);

  useEffect(() => {
    let frameRef: number;
    let lastFrameTime = 0;
    const minFrameInterval = fpsCap > 0 ? 1000 / fpsCap : 0;

    const bufferLength = analyser?.frequencyBinCount ?? 0;
    const dataArray = new Uint8Array(bufferLength);

    const animate = (timestamp?: number) => {
      if (!analyser) return;

      // Throttle if fpsCap is set
      if (minFrameInterval > 0 && timestamp !== undefined) {
        if (timestamp - lastFrameTime < minFrameInterval) {
          frameRef = requestAnimationFrame(animate);
          return;
        }
        lastFrameTime = timestamp;
      }

      // Reconnect analyser just for sampling, then disconnect
      if (disconnectBetweenSamples && sourceNode) {
        try {
          sourceNode.connect(analyser);
        } catch {
          /* already connected or source closed */
        }
      }

      analyser.getByteTimeDomainData(dataArray);

      if (disconnectBetweenSamples && sourceNode) {
        try {
          analyser.disconnect();
        } catch {
          /* already disconnected */
        }
      }

      let maxAmplitude = 0;
      for (let i = 0; i < bufferLength; i++) {
        const sample = Math.abs(dataArray[i] - 128) / 128;
        if (sample > maxAmplitude) maxAmplitude = sample;
      }

      const baseHeight = Math.pow(maxAmplitude, 0.6) * SENSITIVITY;
      const barCount = state.bars.length;

      state.bars.forEach((bar, index) => {
        const position = barCount > 1 ? index / (barCount - 1) : 0.5;
        const centerWeight = Math.sin(position * Math.PI);
        const noise = 0.03 + Math.random() * 1.8;
        const targetHeight = Math.max(MIN_HEIGHT, Math.min(1, baseHeight * noise * centerWeight));

        const currentHeight = state.heights[index] ?? MIN_HEIGHT;
        const smoothing = targetHeight > currentHeight ? ATTACK : RELEASE;
        const newHeight = currentHeight + (targetHeight - currentHeight) * smoothing;
        state.heights[index] = newHeight;

        bar.style.setProperty("--height", `${newHeight * 100}%`);
      });

      frameRef = requestAnimationFrame(animate);
    };

    animate();

    return () => {
      if (frameRef) {
        cancelAnimationFrame(frameRef);
      }
    };
  }, [analyser, state, fpsCap, disconnectBetweenSamples, sourceNode]);

  return (
    <div ref={containerRef} className={cn("flex items-center justify-center gap-[2px] overflow-hidden", className)} />
  );
}

function makeBar(): HTMLDivElement {
  const bar = document.createElement("div");
  bar.style.setProperty("--height", `${MIN_HEIGHT * 100}%`);
  bar.style.setProperty("--width", `${BAR_WIDTH}px`);
  bar.className = "h-[var(--height)] min-h-[4px] w-[var(--width)] shrink-0 rounded-full bg-current";
  return bar;
}
