import { Suspense } from "react";

import { R3fEmbedScene } from "./r3f-embed-scene";

export default function R3fEmbedPage() {
  return (
    <div className="flex h-screen w-full flex-col bg-zinc-950">
      <p className="shrink-0 px-2 py-1 font-mono text-[10px] text-zinc-500">
        r3f-embed · @react-three/fiber + three · ios-audio-crash repro
      </p>
      <div className="min-h-0 flex-1">
        <Suspense fallback={<div className="p-3 text-sm text-zinc-400">Loading WebGL…</div>}>
          <R3fEmbedScene />
        </Suspense>
      </div>
    </div>
  );
}
