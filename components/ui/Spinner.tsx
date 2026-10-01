/**
 * Small inline spinner (reuses the `.loading-spinner` utility from globals.css)
 * and a full-page LoadingState to replace the app's bare "Loading..." text.
 */
export function Spinner({ className = "" }: { className?: string }) {
  return (
    <span
      className={`loading-spinner ${className}`}
      role="status"
      aria-label="Loading"
    />
  );
}

export function LoadingState({ label = "Loading…" }: { label?: string }) {
  return (
    <div
      className="flex min-h-[40vh] flex-col items-center justify-center gap-3 text-gray-500 dark:text-gray-400"
      role="status"
      aria-live="polite"
    >
      <Spinner className="!h-6 !w-6" />
      <span className="text-sm">{label}</span>
    </div>
  );
}
