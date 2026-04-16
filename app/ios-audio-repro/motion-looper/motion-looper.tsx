"use client";

import { motion } from "motion/react";

/**
 * Continuous Motion-driven animation to add compositor / style work alongside audio.
 */
export function MotionLooper() {
  return (
    <div className="flex items-center gap-3">
      <motion.div
        className="h-10 w-10 rounded-full bg-violet-500 shadow-lg"
        animate={{ rotate: 360 }}
        transition={{ duration: 3, repeat: Infinity, ease: "linear" }}
      />
      <motion.div
        className="h-10 w-10 rounded-lg bg-fuchsia-500 shadow-lg"
        animate={{ y: [0, -12, 0], scale: [1, 1.08, 1] }}
        transition={{ duration: 1.2, repeat: Infinity, ease: "easeInOut" }}
      />
      <span className="text-xs text-zinc-500 dark:text-zinc-400">motion/react loop</span>
    </div>
  );
}
