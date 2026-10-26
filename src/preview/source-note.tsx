import { Icon } from "./icon";

export function SourceNote({ source }: { source: string }) {
  return (
    <section className="px-[3px]">
      <div className="mb-1 flex items-center gap-1.5 text-xs/normal text-hint">
        <Icon name="code" size={16} />
        <h2>Authored in code</h2>
      </div>
      <p className="text-[11px] leading-[1.4] text-hint-foreground">
        Scenes live in your project files. Change the source, and the
        preview updates automatically.
      </p>
      <div className="mt-1.5 rounded-sm border border-code-border bg-secondary px-2 py-[5px] font-mono text-[11px] text-code-foreground">
        {source}
      </div>
    </section>
  );
}
