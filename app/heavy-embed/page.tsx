"use client";

import { useMemo } from "react";

/** Same-origin “heavy app” for iframe stress (large DOM). Tweak COUNT if needed. */
const CELL_COUNT = 8000;

export default function HeavyEmbedPage() {
  const indices = useMemo(() => Array.from({ length: CELL_COUNT }, (_, i) => i), []);

  return (
    <div className="min-h-screen bg-zinc-100 p-2 dark:bg-zinc-950">
      <p className="mb-2 font-mono text-[10px] text-zinc-600 dark:text-zinc-400">
        heavy-embed · {CELL_COUNT} cells · ios-audio-crash repro
      </p>
      <div
        className="grid gap-px"
        style={{
          gridTemplateColumns: "repeat(32, minmax(0, 1fr))",
        }}
      >
        {indices.map((i) => (
          <div
            key={i}
            className="aspect-square rounded-[1px] bg-zinc-400/40 dark:bg-zinc-600/40"
            style={{ opacity: 0.15 + ((i * 13) % 85) / 100 }}
          />
        ))}
      </div>
    </div>
  );
}
