export function ErrorBanner({ error }: { error: string }) {
  if (!error) return null;
  return (
    <div
      role="alert"
      className="mb-5 rounded-lg border border-destructive-border bg-destructive px-[18px] py-3.5 text-[13px] text-destructive-foreground"
    >
      <strong className="block">Rendering or export error</strong>
      <p className="mt-1 whitespace-pre-wrap">{error}</p>
    </div>
  );
}
