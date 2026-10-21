import {
  AlertTriangle,
  Check,
  Circle,
  Info,
  LoaderCircle,
  X,
  type LucideIcon,
} from "lucide-react";
import {
  createContext,
  forwardRef,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type ReactNode,
} from "react";

export function cn(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(" ");
}

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "danger-ghost";
type ButtonSize = "sm" | "md" | "lg" | "icon";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  busy?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    className,
    variant = "secondary",
    size = "md",
    busy = false,
    disabled,
    children,
    ...props
  },
  ref,
) {
  const variants: Record<ButtonVariant, string> = {
    primary:
      "border-transparent bg-primary text-primary-foreground shadow-[0_0_18px_rgb(255_255_255/16%)] hover:bg-primary-hover",
    secondary:
      "border-control-strong bg-surface-raised text-ink hover:bg-surface-inset",
    ghost: "border-transparent bg-transparent text-ink-muted hover:bg-surface-inset hover:text-ink",
    danger:
      "border-danger bg-danger text-white shadow-[0_8px_18px_rgb(179_60_52_/_14%)] hover:bg-danger-strong",
    "danger-ghost":
      "border-transparent bg-transparent text-danger hover:border-danger/20 hover:bg-danger/8",
  };
  const sizes: Record<ButtonSize, string> = {
    sm: "min-h-8 px-3 text-xs",
    md: "min-h-9 px-3.5 text-sm",
    lg: "min-h-11 px-5 text-sm",
    icon: "size-9 p-0",
  };

  return (
    <button
      ref={ref}
      type="button"
      className={cn(
        "relative inline-flex shrink-0 cursor-pointer items-center justify-center gap-2 rounded-full border font-semibold outline-none transition-[background,border-color,color,box-shadow] duration-150 focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-1 focus-visible:ring-offset-canvas disabled:pointer-events-none disabled:opacity-50 pointer-coarse:min-h-11 pointer-coarse:min-w-11",
        variants[variant],
        sizes[size],
        className,
      )}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      {...props}
    >
      {busy ? <LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" /> : null}
      {children}
    </button>
  );
});

interface IconButtonProps extends ButtonProps {
  label: string;
  icon: LucideIcon;
}

export function IconButton({ label, icon: Icon, ...props }: IconButtonProps) {
  return (
    <Button aria-label={label} title={label} size="icon" {...props}>
      <Icon className="size-4" aria-hidden="true" />
    </Button>
  );
}

interface PanelProps extends HTMLAttributes<HTMLElement> {
  children: ReactNode;
  elevated?: boolean;
}

export function Panel({ children, className, elevated = false, ...props }: PanelProps) {
  return (
    <section
      className={cn(
        "relative min-w-0 rounded-xl border border-control bg-surface/70 text-ink backdrop-blur-sm",
        elevated && "bg-surface-raised shadow-raised",
        className,
      )}
      {...props}
    >
      {children}
    </section>
  );
}

interface SectionHeaderProps {
  eyebrow?: string;
  title: string;
  description?: string;
  action?: ReactNode;
  compact?: boolean;
}

export function SectionHeader({
  eyebrow,
  title,
  description,
  action,
  compact = false,
}: SectionHeaderProps) {
  return (
    <div className={cn("flex items-start justify-between gap-4", compact ? "p-4" : "p-5 sm:p-6")}>
      <div className="min-w-0">
        {eyebrow ? <p className="ac-eyebrow">{eyebrow}</p> : null}
        <h2 className={cn("ac-display-title", compact ? "text-base" : "text-xl")}>
          {title}
        </h2>
        {description ? <p className="mt-1 max-w-2xl text-sm leading-relaxed text-ink-muted">{description}</p> : null}
      </div>
      {action ? <div className="flex shrink-0 items-center gap-2">{action}</div> : null}
    </div>
  );
}

interface FieldProps {
  label: string;
  htmlFor?: string;
  hint?: string;
  error?: string | null;
  children: ReactNode;
  className?: string;
}

export function Field({ label, htmlFor, hint, error, children, className }: FieldProps) {
  return (
    <div className={cn("grid min-w-0 gap-1.5", className)}>
      <label htmlFor={htmlFor} className="text-xs font-semibold text-ink-muted">
        {label}
      </label>
      {children}
      {error ? <p className="text-xs text-danger">{error}</p> : hint ? (
        <p className="text-xs leading-relaxed text-ink-faint">{hint}</p>
      ) : null}
    </div>
  );
}

export type StatusTone = "neutral" | "info" | "success" | "warning" | "danger" | "live";

interface StatusBadgeProps {
  label: string;
  tone?: StatusTone;
  pulse?: boolean;
  className?: string;
}

export function StatusBadge({
  label,
  tone = "neutral",
  pulse = false,
  className,
}: StatusBadgeProps) {
  const tones: Record<StatusTone, { shell: string; dot: string }> = {
    neutral: { shell: "border-control bg-surface-inset text-ink-muted", dot: "bg-ink-faint" },
    info: { shell: "border-info/20 bg-info/8 text-info-strong", dot: "bg-info" },
    success: { shell: "border-success/20 bg-success/8 text-success-strong", dot: "bg-success" },
    warning: { shell: "border-warning/20 bg-warning/8 text-warning-strong", dot: "bg-warning" },
    danger: { shell: "border-danger/20 bg-danger/8 text-danger", dot: "bg-danger" },
    live: { shell: "border-primary/20 bg-primary/8 text-primary", dot: "bg-primary" },
  };
  const config = tones[tone];
  return (
    <span
      className={cn(
        "inline-flex min-h-6 items-center gap-1.5 rounded-full border px-2.5 text-[11px] font-medium whitespace-nowrap",
        config.shell,
        className,
      )}
    >
      <span className="relative flex size-2">
        {pulse ? (
          <span
            className={cn(
              "absolute inline-flex size-full animate-ping rounded-full opacity-50 motion-reduce:animate-none",
              config.dot,
            )}
          />
        ) : null}
        <span className={cn("relative inline-flex size-2 rounded-full", config.dot)} />
      </span>
      {label}
    </span>
  );
}

interface EmptyStateProps {
  icon?: LucideIcon;
  title: string;
  description: string;
  action?: ReactNode;
  compact?: boolean;
}

export function EmptyState({
  icon: Icon = Circle,
  title,
  description,
  action,
  compact = false,
}: EmptyStateProps) {
  return (
    <div className={cn("grid content-center justify-items-center text-center", compact ? "px-4 py-8" : "px-6 py-14")}>
      <div className="mb-4 grid size-10 place-items-center rounded-lg border border-control bg-surface-inset text-ink-muted">
        <Icon className="size-5" aria-hidden="true" />
      </div>
      <h3 className="ac-display-title text-base">{title}</h3>
      <p className="mt-1 max-w-sm text-sm leading-relaxed text-ink-muted">{description}</p>
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

export function Metric({
  label,
  value,
  className,
}: {
  label: string;
  value: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("min-w-0", className)}>
      <dt className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-faint">{label}</dt>
      <dd className="mt-1 truncate font-mono text-xs text-ink">{value}</dd>
    </div>
  );
}

interface ToastProps {
  tone: "success" | "danger" | "info";
  children: ReactNode;
  onDismiss: () => void;
}

export function Toast({ tone, children, onDismiss }: ToastProps) {
  const Icon = tone === "success" ? Check : tone === "danger" ? AlertTriangle : Info;
  return (
    <div
      role={tone === "danger" ? "alert" : "status"}
      className={cn(
        "fixed bottom-[calc(1rem+env(safe-area-inset-bottom))] right-4 z-[90] flex max-w-sm items-start gap-3 rounded-lg border bg-surface-raised p-3 text-sm shadow-raised animate-in",
        tone === "success" && "border-success/30",
        tone === "danger" && "border-danger/30",
        tone === "info" && "border-info/30",
      )}
    >
      <Icon
        className={cn(
          "mt-0.5 size-4 shrink-0",
          tone === "success" && "text-success",
          tone === "danger" && "text-danger",
          tone === "info" && "text-info",
        )}
        aria-hidden="true"
      />
      <span className="leading-relaxed">{children}</span>
      <button
        type="button"
        onClick={onDismiss}
        className="ml-auto rounded p-1 text-ink-muted outline-none hover:bg-surface-inset focus-visible:ring-2 focus-visible:ring-focus"
        aria-label="Dismiss notification"
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}

interface ConfirmOptions {
  title: string;
  description: string;
  confirmLabel: string;
  tone?: "danger" | "primary";
  requiredText?: string;
}

interface ConfirmState extends ConfirmOptions {
  resolve: (value: boolean) => void;
}

const ConfirmContext = createContext<((options: ConfirmOptions) => Promise<boolean>) | null>(null);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [confirmation, setConfirmation] = useState<ConfirmState | null>(null);
  const [confirmationText, setConfirmationText] = useState("");
  const confirmButtonRef = useRef<HTMLButtonElement>(null);

  const confirm = useCallback((options: ConfirmOptions) => new Promise<boolean>((resolve) => {
    setConfirmationText("");
    setConfirmation({ ...options, resolve });
  }), []);

  const settle = useCallback((value: boolean) => {
    setConfirmation((current) => {
      current?.resolve(value);
      return null;
    });
  }, []);

  useEffect(() => {
    if (!confirmation) return;
    confirmButtonRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") settle(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [confirmation, settle]);

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {confirmation ? (
        <div
          className="fixed inset-0 z-[100] grid place-items-center bg-ink/35 p-4 backdrop-blur-[2px]"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) settle(false);
          }}
        >
          <div
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="confirm-title"
            aria-describedby="confirm-description"
            className="w-full max-w-md rounded-xl border border-control bg-surface-raised p-5 shadow-[0_28px_80px_rgb(24_33_30_/_28%)]"
          >
            <div className="flex gap-3">
              <div className="grid size-10 shrink-0 place-items-center rounded-lg bg-danger/10 text-danger">
                <AlertTriangle className="size-5" />
              </div>
              <div>
                <h2 id="confirm-title" className="font-display text-lg font-semibold">
                  {confirmation.title}
                </h2>
                <p id="confirm-description" className="mt-1 text-sm leading-relaxed text-ink-muted">
                  {confirmation.description}
                </p>
              </div>
            </div>
            {confirmation.requiredText ? (
              <label className="mt-4 block text-sm text-ink-muted">
                Type <strong className="text-ink">{confirmation.requiredText}</strong> to confirm
                <input
                  aria-label="Confirmation label"
                  className="mt-2 w-full rounded-lg border border-control bg-surface px-3 py-2 text-ink"
                  value={confirmationText}
                  onChange={(event) => setConfirmationText(event.target.value)}
                  autoComplete="off"
                />
              </label>
            ) : null}
            <div className="mt-6 flex justify-end gap-2">
              <Button onClick={() => settle(false)}>Cancel</Button>
              <Button
                ref={confirmButtonRef}
                variant={confirmation.tone === "primary" ? "primary" : "danger"}
                disabled={Boolean(confirmation.requiredText) && confirmationText !== confirmation.requiredText}
                onClick={() => settle(true)}
              >
                {confirmation.confirmLabel}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </ConfirmContext.Provider>
  );
}

export function useConfirm() {
  const context = useContext(ConfirmContext);
  if (!context) throw new Error("useConfirm must be used inside ConfirmProvider.");
  return context;
}
