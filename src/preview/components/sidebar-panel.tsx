import { useState, type ComponentPropsWithoutRef, type ReactNode } from "react";
import { Icon } from "./icon";

export interface SidebarPanelProps
  extends Omit<ComponentPropsWithoutRef<"section">, "title"> {
  icon?: string;
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  collapsible?: boolean;
  defaultCollapsed?: boolean;
  collapsed?: boolean;
  onToggleCollapse?: (collapsed: boolean) => void;
  headerClassName?: string;
  contentClassName?: string;
  children: ReactNode;
}

export function SidebarPanel({
  icon,
  title,
  subtitle,
  actions,
  collapsible = true,
  defaultCollapsed = false,
  collapsed: controlledCollapsed,
  onToggleCollapse,
  className = "",
  headerClassName = "",
  contentClassName = "",
  children,
  ...props
}: SidebarPanelProps) {
  const [internalCollapsed, setInternalCollapsed] = useState(defaultCollapsed);
  const isControlled = controlledCollapsed !== undefined;
  const isCollapsed = isControlled ? controlledCollapsed : internalCollapsed;

  const toggleCollapse = () => {
    const next = !isCollapsed;
    if (!isControlled) {
      setInternalCollapsed(next);
    }
    onToggleCollapse?.(next);
  };

  const titleString = typeof title === "string" ? title : "Panel";

  return (
    <section
      className={`flex min-h-0 flex-1 flex-col overflow-hidden bg-card ${className}`}
      {...props}
    >
      {/* Header Sidebar: Seragam antar sidebar item */}
      <div
        className={`flex h-8 shrink-0 select-none items-center justify-between border-b border-separator px-2.5 py-1 text-[11px] ${headerClassName}`}
      >
        {/* Left: Icon, Title, and optional Subtitle */}
        <div
          className={`flex min-w-0 flex-1 items-center gap-1.5 ${
            collapsible ? "cursor-pointer" : ""
          }`}
          onClick={collapsible ? toggleCollapse : undefined}
        >
          {icon && (
            <Icon
              name={icon}
              size={14}
              className="shrink-0 text-muted-foreground"
            />
          )}
          <h2 className="truncate text-[11px] font-medium tracking-tight text-foreground">
            {title}
          </h2>
          {subtitle && (
            <span className="truncate font-mono text-[11px] text-meta">
              {subtitle}
            </span>
          )}
        </div>

        {/* Right: Custom Control Buttons and Minimize Button */}
        <div className="flex shrink-0 items-center gap-1">
          {actions}

          {collapsible && (
            <button
              type="button"
              className="flex size-5 items-center justify-center rounded text-control transition-colors hover:bg-accent hover:text-accent-foreground"
              aria-label={
                isCollapsed
                  ? `Expand ${titleString}`
                  : `Minimize ${titleString}`
              }
              aria-expanded={!isCollapsed}
              title={isCollapsed ? "Expand" : "Minimize"}
              onClick={(e) => {
                e.stopPropagation();
                toggleCollapse();
              }}
            >
              <Icon
                name={isCollapsed ? "chevron-right" : "chevron-down"}
                size={13}
              />
            </button>
          )}
        </div>
      </div>

      {/* Content Sidebar */}
      {!isCollapsed && (
        <div className={`min-h-0 flex-1 overflow-y-auto ${contentClassName}`}>
          {children}
        </div>
      )}
    </section>
  );
}
