import { saveStudioPreferences } from "../state/studio-preferences";
import { useEffect, useState } from "react";
import { Icon } from "../components/icon";

export function StudioHeader() {
  const [theme, setTheme] = useState<"light" | "dark">(() =>
    document.documentElement.classList.contains("dark") ? "dark" : "light",
  );
  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle("dark", theme === "dark");
    root.style.colorScheme = theme;
    saveStudioPreferences({ theme });
    const color = getComputedStyle(root)
      .getPropertyValue("--background")
      .trim();
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute("content", color);
  }, [theme]);
  return (
    <header className="flex min-h-12 shrink-0 flex-wrap items-center justify-between gap-3 border-b border-rule px-4">
      <a
        href="/"
        className="flex items-center gap-[11px] text-[21px] font-semibold tracking-[-0.6px]"
      >
        <span className="flex h-[29px] w-[29px] items-center justify-center rounded-lg bg-primary text-brand-ink">
          <svg
            viewBox="0 0 24 24"
            width={19}
            height={19}
            fill="none"
            aria-hidden="true"
          >
            <path
              d="M6 20V10.5C6 6.91 8.91 4 12.5 4H13.5"
              stroke="currentColor"
              strokeWidth={2.4}
              strokeLinecap="round"
            />
            <path
              d="M20 5C20 10.8 15.5 15 10 15C10 9.2 14.5 5 20 5Z"
              fill="currentColor"
            />
            <path
              d="M11 14.5L16.2 18.8"
              stroke="currentColor"
              strokeWidth={2.4}
              strokeLinecap="round"
            />
            <rect
              x={14.8}
              y={16.6}
              width={4.4}
              height={4.4}
              rx={0.9}
              transform="rotate(45 17 18.8)"
              fill="currentColor"
            />
          </svg>
        </span>
        ritween
        <span className="ml-[3px] rounded-sm border border-badge px-1.5 py-0.5 text-[11px] font-medium tracking-normal text-badge-foreground">
          dev preview
        </span>
      </a>
      <div className="flex items-center gap-[22px] text-xs/normal text-muted-foreground">
        <span className="hidden sm:inline">Code authored. Frame perfect.</span>
        <button
          type="button"
          aria-label={
            theme === "dark" ? "Switch to light mode" : "Switch to dark mode"
          }
          aria-pressed={theme === "dark"}
          onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
          className="flex items-center gap-1.5 hover:text-accent-foreground"
        >
          <Icon name={theme === "dark" ? "sun" : "moon"} size={15} />
          {theme === "dark" ? "Light" : "Dark"}
        </button>
        <a
          href="https://github.com/gpuweb/gpuweb"
          target="_blank"
          rel="noreferrer"
          className="flex items-center gap-[7px] hover:text-accent-foreground"
        >
          <Icon name="code" size={15} /> WebGPU runtime
        </a>
      </div>
    </header>
  );
}
