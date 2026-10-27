export function ErrorBanner({ error }: { error: string }) {
  if (!error) return null;
  return (
    <div
      role="alert"
      className="shrink-0 border-y border-destructive-border bg-destructive px-4 py-2.5 text-[13px] text-destructive-foreground"
    >
      <strong className="block">Rendering or export error</strong>
      <p className="mt-1 whitespace-pre-wrap">{error}</p>
    </div>
  );
}
