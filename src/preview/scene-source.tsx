import { useState } from "react";
import type { SceneEntry } from "../engine/types";
import { miniButton } from "./controls";
import { highlightLines, type HighlightKind } from "./highlight";
import { Icon } from "./icon";

const tokenClass: Partial<Record<HighlightKind, string>> = {
  comment: "hl-comment",
  string: "hl-string",
  keyword: "hl-keyword",
  number: "hl-number",
  function: "hl-function",
  type: "hl-type",
  punctuation: "hl-punctuation",
};

export function SceneSource({
  scenes,
  sources,
  activeId,
  pinnedId,
  onPin,
  onFollow,
  onExpand,
  expanded = false,
}: {
  scenes: readonly SceneEntry[];
  sources: Record<string, string | null>;
  activeId: string;
  pinnedId: string | null;
  onPin: (id: string) => void;
  onFollow: () => void;
  onExpand?: () => void;
  expanded?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const shownId =
    pinnedId && scenes.some((scene) => scene.id === pinnedId)
      ? pinnedId
      : activeId;
  const scene = scenes.find((item) => item.id === shownId) ?? scenes[0];
  const code = scene && Object.hasOwn(sources, scene.source) ? sources[scene.source] : null;
  const lines = code == null ? [] : highlightLines(code);
  const copy = () => {
    if (code == null) return;
    void navigator.clipboard?.writeText(code).then(
      () => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1200);
      },
      () => {},
    );
  };
  if (!scene) return null;
  return (
    <section
      data-scene-source
      aria-label={`Source of ${scene.source}`}
      className="flex min-h-0 flex-1 flex-col border-t border-separator bg-card"
    >
      <div className="flex shrink-0 items-center gap-1.5 px-3 pt-2 pb-1">
        <Icon name="code" size={16} />
        <h2 className="text-xs/normal font-medium">Scene source</h2>
        <span className="min-w-0 truncate font-mono text-[11px] text-code-foreground">
          {scene.name}
        </span>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          {pinnedId && (
            <button type="button" className={miniButton} onClick={onFollow}>
              Follow
            </button>
          )}
          {onExpand && !expanded && (
            <button type="button" className={miniButton} onClick={onExpand}>
              Expand
            </button>
          )}
          <button
            type="button"
            className={miniButton}
            disabled={code == null}
            onClick={copy}
          >
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
      </div>
      <div className="flex shrink-0 gap-1 overflow-x-auto px-3 pb-2">
        {scenes.map((item) => {
          const selected = item.id === scene.id;
          const playing = item.id === activeId;
          return (
            <button
              key={item.id}
              type="button"
              aria-pressed={selected}
              className={`flex h-[22px] max-w-[180px] shrink-0 items-center gap-1 rounded-[3px] border px-1.5 font-mono text-[11px] ${
                selected
                  ? "border-primary bg-secondary text-foreground"
                  : "border-code-border text-code-foreground hover:text-foreground"
              }`}
              onClick={() => onPin(item.id)}
            >
              {playing && (
                <span className="size-1.5 shrink-0 rounded-full bg-playhead" />
              )}
              <span className="truncate">{item.source}</span>
            </button>
          );
        })}
      </div>
      {code == null ? (
        <p className="px-3 pb-3 text-[11px] leading-[1.4] text-hint-foreground">
          The preview could not read {scene.source}. Scene paths are files next
          to the manifest.
        </p>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto bg-secondary" tabIndex={0}>
          <pre className="m-0 w-max min-w-full px-2 py-1.5 font-mono text-xs leading-5 text-foreground">
            {lines.map((line, lineIndex) => (
              <div key={lineIndex} className="flex">
                <span className="w-10 shrink-0 select-none pr-2 text-right text-meta">
                  {lineIndex + 1}
                </span>
                <span className="whitespace-pre">
                  {line.length === 0
                    ? " "
                    : line.map((token, tokenIndex) => (
                        <span
                          key={tokenIndex}
                          className={tokenClass[token.kind]}
                        >
                          {token.text}
                        </span>
                      ))}
                </span>
              </div>
            ))}
          </pre>
        </div>
      )}
    </section>
  );
}
