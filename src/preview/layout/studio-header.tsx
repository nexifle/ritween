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
    localStorage.setItem("rimotion-theme", theme);
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
          <Icon name="film" size={19} />
        </span>
        rimotion
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
