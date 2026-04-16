"use client";

import { Canvas, useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import type { Group } from "three";

const BOX_COUNT = 96;

function SpinningField() {
  const groupRef = useRef<Group>(null);
  const indices = useMemo(() => Array.from({ length: BOX_COUNT }, (_, i) => i), []);

  useFrame((state) => {
    const g = groupRef.current;
    if (!g) return;
    const t = state.clock.elapsedTime;
    g.rotation.y = t * 0.35;
    g.rotation.z = Math.sin(t * 0.4) * 0.15;
  });

  return (
    <group ref={groupRef}>
      {indices.map((i) => {
        const col = 8;
        const x = (i % col) - col / 2 + 0.5;
        const z = Math.floor(i / col) - 5;
        const y = Math.sin(i * 0.7) * 0.4;
        const hue = (i * 37) % 360;
        return (
          <mesh key={i} position={[x * 0.85, y, z * 0.85]}>
            <boxGeometry args={[0.42, 0.42, 0.42]} />
            <meshStandardMaterial color={`hsl(${hue}, 70%, 58%)`} metalness={0.25} roughness={0.45} />
          </mesh>
        );
      })}
    </group>
  );
}

export function R3fEmbedScene() {
  return (
    <Canvas
      className="h-full w-full touch-none"
      camera={{ position: [6, 4, 8], fov: 45 }}
      dpr={[1, 2]}
      gl={{ antialias: true, alpha: false }}
    >
      <color attach="background" args={["#0c0c0f"]} />
      <fog attach="fog" args={["#0c0c0f", 12, 32]} />
      <ambientLight intensity={0.35} />
      <directionalLight position={[8, 10, 6]} intensity={1.2} />
      <pointLight position={[-6, 4, -4]} intensity={0.6} color="#a78bfa" />
      <SpinningField />
    </Canvas>
  );
}
