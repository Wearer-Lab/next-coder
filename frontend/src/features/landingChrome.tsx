import { LoaderCircle, TerminalSquare, type LucideIcon } from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type ReactNode,
} from "react";

import type { MarketingRoute } from "../marketingRoute";
import "./landing.css";

/**
 * The signed-out front door, in the "intelligence design" system: black canvas, one ambient
 * backdrop, a white pill navigation, a pixel display face and glowing pill calls to action.
 *
 * Everything in this file is shared by the three marketing pages so the chrome cannot drift
 * between them. The copy lives in the pages; only the furniture lives here.
 */

const BACKDROP_POSTER = "/media/landing-poster.jpg";
const BACKDROP_VIDEO = "/media/landing-loop.mp4";

function cx(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(" ");
}

/**
 * The ambient layer behind every marketing page.
 *
 * The reference design puts a full-bleed loop behind a single screen. Our pages scroll, so the
 * backdrop is fixed and the content rides on top of it. The poster is always present as the base
 * layer: it is what shows before the video's first frame, and it is what remains if the video is
 * blocked, offline, or skipped for reduced motion.
 *
 * The video is first-party (`/media/landing-loop.mp4`) on purpose. The gateway serves the console
 * under a strict `media-src 'self'` policy, so a third-party CDN clip would be blocked anyway —
 * and a first-party asset is one fewer external dependency on the front door.
 */
export function LandingBackdrop({ video = false }: { video?: boolean }) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [motion, setMotion] = useState(false);

  useEffect(() => {
    const query = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!query) return;
    const update = () => setMotion(!query.matches);
    update();
    query.addEventListener?.("change", update);
    return () => query.removeEventListener?.("change", update);
  }, []);

  useEffect(() => {
    const element = videoRef.current;
    if (!element || !motion) return;
    const play = () => {
      // `play()` rejects when the browser blocks autoplay, and returns undefined in jsdom.
      const started = element.play() as Promise<void> | undefined;
      if (started && typeof started.catch === "function") started.catch(() => undefined);
    };
    play();
    // A hidden tab should not keep a looping video decoding frames nobody can see.
    const onVisibility = () => {
      if (document.hidden) element.pause();
      else play();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      element.pause();
    };
  }, [motion]);

  return (
    <div className="landing__backdrop" aria-hidden="true">
      {video && motion ? (
        <video
          ref={videoRef}
          className="landing__backdrop-video"
          src={BACKDROP_VIDEO}
          poster={BACKDROP_POSTER}
          autoPlay
          muted
          loop
          playsInline
          preload="auto"
          tabIndex={-1}
        />
      ) : null}
      <div
        className="landing__backdrop-poster"
        style={{ backgroundImage: `url(${BACKDROP_POSTER})` }}
      />
      <div className="landing__backdrop-scrim" />
    </div>
  );
}

export interface LandingNavLink {
  href: string;
  label: string;
}

/**
 * The header: a white circle for the brand, a white pill for the sections, a dark pill for the
 * account actions, and a burger that opens the same links as a sheet on a narrow screen.
 */
export function LandingNav({
  links,
  activeHref,
  actions,
  brandHref = "#/",
  brandLabel = "Agent Controller",
}: {
  links: LandingNavLink[];
  activeHref?: string;
  actions?: ReactNode;
  brandHref?: string;
  brandLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const burgerRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      burgerRef.current?.focus();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open]);

  useEffect(() => {
    const onResize = () => {
      if (window.innerWidth > 760) setOpen(false);
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  return (
    <header className="landing__bar">
      <div className="landing__bar-inner">
        <a className="landing__logo" href={brandHref} aria-label={brandLabel}>
          <TerminalSquare className="landing__logo-glyph" aria-hidden="true" />
        </a>

        <nav className="landing__pill" aria-label="Page sections">
          {links.map((link) => (
            <a
              key={link.href}
              className="landing__pill-link"
              href={link.href}
              data-active={link.href === activeHref || undefined}
            >
              {link.label}
            </a>
          ))}
        </nav>

        <div className="landing__bar-actions">{actions}</div>

        <button
          ref={burgerRef}
          type="button"
          className="landing__burger"
          aria-label={open ? "Close navigation" : "Open navigation"}
          aria-expanded={open}
          aria-controls="landing-mobile-menu"
          onClick={() => setOpen((value) => !value)}
        >
          <span aria-hidden="true" />
          <span aria-hidden="true" />
          <span aria-hidden="true" />
        </button>
      </div>

      {open ? (
        <div
          className="landing__mobile"
          id="landing-mobile-menu"
          onClick={(event) => {
            if (event.target === event.currentTarget) setOpen(false);
          }}
        >
          <div className="landing__sheet" role="dialog" aria-modal="true" aria-label="Navigation menu">
            <nav className="landing__mobile-nav" aria-label="Mobile navigation">
              {links.map((link, index) => (
                <a
                  key={link.href}
                  className="landing__mobile-link"
                  href={link.href}
                  data-active={link.href === activeHref || undefined}
                  style={{ "--i": index } as CSSProperties}
                  onClick={() => setOpen(false)}
                >
                  {link.label}
                </a>
              ))}
            </nav>
            {actions ? <div className="landing__mobile-actions">{actions}</div> : null}
          </div>
        </div>
      ) : null}
    </header>
  );
}

type LandingButtonVariant = "primary" | "secondary" | "ghost" | "dark";
type LandingButtonSize = "sm" | "md" | "lg";

/**
 * The marketing call to action. The console's `Button` is themed for the app shell; this one is
 * the white, softly glowing pill from the reference design, so the landing pages do not have to
 * fight the console palette with `!important` overrides.
 */
export function LandingButton({
  variant = "primary",
  size = "md",
  busy = false,
  disabled = false,
  className,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: LandingButtonVariant;
  size?: LandingButtonSize;
  busy?: boolean;
}) {
  return (
    <button
      type="button"
      className={cx("landing__cta", `landing__cta--${variant}`, `landing__cta--${size}`, className)}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      {...props}
    >
      {busy ? <LoaderCircle className="landing__cta-spinner" aria-hidden="true" /> : null}
      {children}
    </button>
  );
}

/**
 * Placeholder frames for product photography that does not exist yet. Deliberately captioned
 * rather than blank, so an empty slot reads as "shot pending" and not as a broken image.
 */
export function Shot({
  icon: Icon,
  caption,
  ratio,
}: {
  icon: LucideIcon;
  caption: string;
  ratio?: string;
}) {
  return (
    <div className="landing__shot" style={ratio ? { aspectRatio: ratio } : undefined}>
      <Icon className="landing__shot-icon" aria-hidden="true" />
      <p>{caption}</p>
    </div>
  );
}

/**
 * The stagger delay for a reveal, as a custom property the stylesheet reads.
 */
export function revealStyle(delay: string): CSSProperties {
  return { "--d": delay } as CSSProperties;
}

export function LandingBrand({ badge = "NIGHTLY" }: { badge?: string | null }) {
  return (
    <div className="landing__brand">
      <div className="brand-mark brand-mark--muted" aria-hidden="true">
        <TerminalSquare className="size-3.5" />
      </div>
      <div className="brand-copy">
        <p className="brand-copy__name">Agent Controller</p>
        {badge ? <p className="brand-copy__meta">{badge}</p> : null}
      </div>
    </div>
  );
}

const MARKETING_PAGES: Array<{ route: MarketingRoute; href: string; label: string }> = [
  { route: "home", href: "#/", label: "Overview" },
  { route: "developers", href: "#/developers", label: "For developers" },
  { route: "early-access", href: "#/early-access", label: "Hardware" },
];

/**
 * Cross-links between the three signed-out pages. Without this each page is only reachable by
 * typing its hash, which makes two thirds of the marketing site invisible.
 */
export function MarketingSwitch({ current }: { current: MarketingRoute }) {
  return (
    <nav className="landing__switch" aria-label="Other pages">
      {marketingPageLinks(current).map((page) => (
        <a key={page.href} href={page.href}>
          {page.label}
        </a>
      ))}
    </nav>
  );
}

/**
 * The same cross-links, shaped for the pill navigation.
 */
export function marketingPageLinks(current: MarketingRoute): LandingNavLink[] {
  return MARKETING_PAGES.filter((page) => page.route !== current).map((page) => ({
    href: page.href,
    label: page.label,
  }));
}

/**
 * The overlapping rings from the reference header. The rings carry the surfaces the control
 * plane reaches — the agent host, the browser, the phone and the controller — and the pill
 * carries the sentence that qualifies all of them.
 */
export function TrustRow({ icons, children }: { icons: LucideIcon[]; children: ReactNode }) {
  return (
    <div className="landing__trust">
      <div className="landing__trust-rings" aria-hidden="true">
        {icons.map((Icon, index) => (
          <span key={index} className="landing__trust-ring">
            <span className="landing__trust-inner">
              <Icon />
            </span>
          </span>
        ))}
      </div>
      <p className="landing__trust-pill">{children}</p>
    </div>
  );
}

export interface LandingStat {
  /** A single pixel-face glyph, the way the reference design labels its metrics. */
  glyph: string;
  value: number;
  decimals?: number;
  suffix?: string;
  label: string;
}

/**
 * The metric strip from the reference footer.
 */
export function StatStrip({ stats }: { stats: LandingStat[] }) {
  return (
    <div className="landing__stats">
      {stats.map((stat, index) => (
        <div key={stat.label} className="landing__stat">
          <div className="landing__stat-glyph" aria-hidden="true">
            {stat.glyph}
          </div>
          <CountUp
            className="landing__stat-value"
            value={stat.value}
            decimals={stat.decimals}
            suffix={stat.suffix}
            index={index}
          />
          <div className="landing__stat-label">{stat.label}</div>
        </div>
      ))}
    </div>
  );
}

function formatCount(value: number, decimals: number, suffix: string): string {
  return `${value.toFixed(decimals)}${suffix}`;
}

/**
 * Counts a metric up to its value, the way the reference page does.
 *
 * The final value is what the server-rendered markup already contains; the animation writes to
 * the node directly instead of through React state, so a sixty-frame count does not re-render a
 * page sixty times. The reset to zero happens under the same fade that reveals the strip, so the
 * swap is never seen.
 */
export function CountUp({
  value,
  decimals = 0,
  suffix = "",
  index = 0,
  className,
}: {
  value: number;
  decimals?: number;
  suffix?: string;
  index?: number;
  className?: string;
}) {
  const ref = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ?? false;
    if (reduced || typeof window.requestAnimationFrame !== "function") return;

    let frame = 0;
    let timer = 0;
    const duration = 1500 + index * 80;
    const start = () => {
      const startedAt = performance.now();
      const tick = (now: number) => {
        const progress = Math.min((now - startedAt) / duration, 1);
        const eased = 1 - Math.pow(1 - progress, 3);
        element.textContent = formatCount(value * eased, decimals, suffix);
        if (progress < 1) {
          frame = window.requestAnimationFrame(tick);
        } else {
          element.textContent = formatCount(value, decimals, suffix);
        }
      };
      frame = window.requestAnimationFrame(tick);
    };
    timer = window.setTimeout(start, 480 + index * 90);
    return () => {
      window.clearTimeout(timer);
      window.cancelAnimationFrame(frame);
    };
  }, [value, decimals, suffix, index]);

  return (
    <span ref={ref} className={className}>
      {formatCount(value, decimals, suffix)}
    </span>
  );
}
