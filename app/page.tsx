import Link from "next/link";

export default function Home() {
  return (
    <div className="flex min-h-full flex-col items-center justify-center bg-zinc-50 px-6 py-16 font-sans dark:bg-black">
      <main className="flex max-w-md flex-col gap-4 text-center">
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">ios-audio-crash</h1>
        <p className="text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">
          Open the repro page on an iPhone, grant the mic, start recording, and leave it past ~60s to see if Safari
          reloads.
        </p>
        <Link
          href="/ios-audio-repro"
          className="inline-flex items-center justify-center rounded-full bg-zinc-900 px-5 py-3 text-sm font-medium text-white dark:bg-zinc-100 dark:text-zinc-900"
        >
          Go to audio repro
        </Link>
      </main>
    </div>
  );
}
