import {
  Boxes,
  Cable,
  Check,
  Cpu,
  GalleryVerticalEnd,
  KeyRound,
  ListChecks,
  Monitor,
  Radio,
  ScrollText,
  ShieldAlert,
  ShieldCheck,
  Smartphone,
  Sparkles,
  TerminalSquare,
  type LucideIcon,
} from "lucide-react";

import { BrandMark } from "../brandMark";
import type { AuthConfig, ClerkBridge } from "../types";
import {
  LandingBackdrop,
  LandingButton,
  LandingNav,
  MarketingSwitch,
  Shot,
  StatStrip,
  TrustRow,
  revealStyle,
} from "./landingChrome";
import { SignInNotice, signInAvailability } from "./signInNotice";

interface LandingPageProps {
  authConfig: AuthConfig;
  clerk: ClerkBridge | null;
}

const navLinks = [
  { href: "#how-it-works", label: "How it works" },
  { href: "#hardware", label: "Hardware" },
  { href: "#pricing", label: "Pricing" },
  { href: "#faq", label: "FAQ" },
];

const steps: Array<{ icon: LucideIcon; title: string; body: string }> = [
  {
    icon: Cable,
    title: "Pair your T3 Code host",
    body: "Run one setup command on the machine already running T3 Code. Provider logins and network prompts stay on that machine.",
  },
  {
    icon: TerminalSquare,
    title: "Launch your first thread",
    body: "Pick a workspace and model from the live snapshot. A thread that actually replies is what proves the connection works.",
  },
  {
    icon: Cpu,
    title: "Add a controller, or don't",
    body: "Claim the hardware controller and point it at that thread — or stay browser-only. Both are complete setups.",
  },
];

const hardwareSpecs = [
  { term: "Display", detail: "2.13in e-ink, partial refresh" },
  { term: "Input", detail: "EC11 rotary encoder + press" },
  { term: "Silicon", detail: "ESP32, WiFi, signed OTA" },
  { term: "Credentials", detail: "Per-device secret, rotatable" },
];

const features: Array<{ icon: LucideIcon; title: string; body: string }> = [
  {
    icon: ShieldAlert,
    title: "Policy gate with real approvals",
    body: "Prompts, media, session control and shell input are screened before dispatch. Anything risky stops and waits for a decision from you.",
  },
  {
    icon: ListChecks,
    title: "Per-command timelines",
    body: "Every command carries its own status trail — created, screened, dispatched, completed — with the actor and result on each transition.",
  },
  {
    icon: Boxes,
    title: "Fleet and claim codes",
    body: "Register a dev device, pre-provision a factory batch, or claim hardware with a printed code. Rotate or revoke a secret in one click.",
  },
  {
    icon: GalleryVerticalEnd,
    title: "Voice and camera as context",
    body: "Push-to-talk uploads, transcribes and dispatches. Camera frames attach to a prompt. Retention is a number you set.",
  },
  {
    icon: Cable,
    title: "T3 environments, health-checked",
    body: "Paired workstations report reachability, credential expiry and a live workspace snapshot of projects, threads and harnesses.",
  },
  {
    icon: ScrollText,
    title: "Redacted diagnostics",
    body: "Export a support bundle without tokens, transcripts or raw commands. Audit events cover every account and device change.",
  },
];

/**
 * `cta` is what the tier's button does, not merely what it says. Only `signup` has somewhere real
 * to go today, so the other two are wired to the on-page answer rather than to a dead `href="#"`.
 */
type TierCta = { kind: "signup"; label: string } | { kind: "anchor"; label: string; href: string } | { kind: "pending"; label: string; note: string };

const tiers: Array<{
  name: string;
  badge: string;
  price: string;
  per: string;
  blurb: string;
  items: string[];
  cta: TierCta;
  featured: boolean;
}> = [
  {
    name: "Self-hosted",
    badge: "MIT",
    price: "$0",
    per: "",
    blurb: "Run the gateway yourself. Same code, your infrastructure.",
    items: [
      "Unlimited environments and devices",
      "Convex or file-backed storage",
      "Firmware and gateway source",
      "Community support",
    ],
    cta: { kind: "anchor", label: "How self-hosting works", href: "#faq-self-host" },
    featured: false,
  },
  {
    name: "Hosted",
    badge: "Nightly · free",
    price: "$12",
    per: "/mo",
    blurb: "We run the gateway. You bring the T3 host and provider keys.",
    items: [
      "Managed gateway and realtime",
      "Durable in-app notifications",
      "90-day command history",
      "Signed OTA firmware channel",
    ],
    cta: { kind: "signup", label: "Create your account" },
    featured: true,
  },
  {
    name: "Team",
    badge: "Waitlist",
    price: "$29",
    per: "/seat",
    blurb: "Shared fleets, delegated approvals, and an audit trail per member.",
    items: [
      "Shared device and environment fleets",
      "Delegated approval routing",
      "SSO and per-seat policy profiles",
      "Priority hardware allocation",
    ],
    cta: { kind: "pending", label: "Join the waitlist", note: "The team waitlist is not open yet." },
    featured: false,
  },
];

const faq = [
  {
    id: "faq-runs-model",
    q: "Does Next Coder run the model?",
    a: "No. The agent runs in the T3 Code environment on your own machine, against your own provider keys. The gateway authenticates you, screens the intent, and dispatches it — it never sees a model response it did not ask for.",
  },
  {
    id: "faq-asleep",
    q: "What happens if my machine is asleep?",
    a: "The environment reports as unreachable and dispatch fails fast with the reason. Nothing queues silently. Reachability, credential expiry and last-snapshot time are all on the Environments page.",
  },
  {
    id: "faq-hardware-required",
    q: "Do I need the hardware controller?",
    a: "No. Browser-only is a first-class setup and the onboarding wizard has a step that says so. The controller is for the one thread you keep returning to.",
  },
  {
    id: "faq-device-secrets",
    q: "Where do device secrets live?",
    a: "Each device gets its own secret, shown once at registration. You can rotate it, revoke it, or run a transfer reset that unclaims the device and issues a fresh claim code.",
  },
  {
    id: "faq-self-host",
    q: "Can I self-host?",
    a: "Yes — the gateway is the same code either way, with file-backed or Convex storage. Rate limits are in-memory by default; swap in a shared store for multi-process deployments.",
  },
];

/**
 * The signed-out front door. Before this existed, an unauthenticated visitor was dropped into the
 * full app shell — empty sidebar, empty Operate page, and a small "Sign in" button in the corner —
 * with nothing explaining what the product was or what signing in would get them.
 */
export function LandingPage({ authConfig, clerk }: LandingPageProps) {
  const signIn = signInAvailability(authConfig, clerk);
  const clerkReady = signIn === "ready";
  const checkingSession = clerkReady && !clerk?.loaded;

  const headerActions = clerkReady ? (
    <>
      <LandingButton variant="dark" size="sm" disabled={checkingSession} onClick={() => clerk?.openSignIn()}>
        Sign in
      </LandingButton>
      <LandingButton variant="primary" size="sm" disabled={checkingSession} onClick={() => clerk?.openSignUp()}>
        Create account
      </LandingButton>
    </>
  ) : null;

  const heroActions = clerkReady ? (
    <div className="landing__actions landing__reveal" style={revealStyle("0.28s")}>
      <LandingButton size="lg" variant="primary" disabled={checkingSession} onClick={() => clerk?.openSignUp()}>
        <Sparkles className="size-4" />
        {checkingSession ? "Checking session…" : "Create your account"}
      </LandingButton>
      <LandingButton size="lg" variant="secondary" disabled={checkingSession} onClick={() => clerk?.openSignIn()}>
        I already have one
      </LandingButton>
    </div>
  ) : (
    // A self-hoster who has not finished wiring Clerk needs the reason, not a dead button — and
    // a gateway that did not answer needs a different reason, because its keys may be fine.
    <SignInNotice
      availability={signIn}
      className="landing__reveal"
      style={revealStyle("0.28s")}
    />
  );

  return (
    <div className="landing">
      <LandingBackdrop video />

      <LandingNav links={navLinks} actions={headerActions} />

      <main className="landing__main" id="main-content">
        <section className="landing__section landing__section--hero">
          <div className="landing__inner landing__hero">
            <div className="landing__hero-copy">
              <div className="landing__reveal" style={revealStyle("0.05s")}>
                <TrustRow icons={[TerminalSquare, Monitor, Smartphone, Radio]}>
                  Remote control for your own agents
                </TrustRow>
              </div>

              <h1 className="landing__hero-title landing__reveal" style={revealStyle("0.1s")}>
                Drive T3 Code from a controller, or from anywhere.
              </h1>

              <p className="landing__lede landing__reveal" style={revealStyle("0.2s")}>
                Next Coder is the control plane between you and the T3 Code environment on your
                own machine. It authenticates you, applies your policy, and dispatches the command. It
                never runs the agent itself — your code and your models stay where they already are.
              </p>

              {heroActions}

              <p className="landing__reassure landing__reveal" style={revealStyle("0.36s")}>
                <ShieldCheck className="size-3.5 shrink-0" aria-hidden="true" />
                Every command is policy-screened, and risky ones wait for your approval.
              </p>
            </div>

            <div className="landing__hero-shots landing__reveal" style={revealStyle("0.44s")} aria-hidden="true">
              <Shot icon={Radio} caption="product shot — controller on a desk beside a laptop" />
              <Shot icon={Smartphone} caption="phone in hand" />
              <Shot icon={Monitor} caption="console screenshot" />
            </div>

            <div className="landing__reveal" style={revealStyle("0.52s")}>
              <StatStrip
                stats={[
                  { glyph: ">", value: steps.length, label: "Steps to first run" },
                  { glyph: "*", value: features.length, label: "Control-plane capabilities" },
                  { glyph: "#", value: tiers.length, label: "Ways to deploy" },
                  { glyph: "%", value: 100, suffix: "%", label: "Credentials stay local" },
                ]}
              />
            </div>
          </div>
        </section>

        <section className="landing__section" id="how-it-works" aria-labelledby="how-it-works-title">
          <div className="landing__inner landing__steps">
            <h2 className="eyebrow">Three steps to first run</h2>
            <p className="landing__section-title" id="how-it-works-title">
              Setup ends the moment a thread answers you.
            </p>
            <ol>
              {steps.map((step, index) => {
                const Icon = step.icon;
                return (
                  <li key={step.title}>
                    <div className="landing__step-head">
                      <div className="landing__step-icon" aria-hidden="true">
                        <Icon />
                      </div>
                      <span className="landing__step-index" aria-hidden="true">Step {index + 1}</span>
                    </div>
                    <h3>{step.title}</h3>
                    <p>{step.body}</p>
                  </li>
                );
              })}
            </ol>
          </div>
        </section>

        <section
          className="landing__section landing__section--sunken"
          id="hardware"
          aria-labelledby="hardware-title"
        >
          <div className="landing__inner landing__hardware">
            <Shot icon={Radio} ratio="4 / 3" caption={'hero shot — 2.13" e-ink face, encoder detail'} />
            <div>
              <p className="eyebrow eyebrow--accent">The controller</p>
              <h2 id="hardware-title" className="landing__hardware-title">
                One knob, one e-ink face, no notifications.
              </h2>
              <p className="landing__lede">
                A dedicated desk object for the thread you already care about. Turn to pick an intent,
                press to send, glance to see whether the agent is waiting on you. It polls compact
                display state over WiFi and never holds your provider credentials.
              </p>
              <dl className="landing__specs">
                {hardwareSpecs.map((spec) => (
                  <div key={spec.term}>
                    <dt>{spec.term}</dt>
                    <dd>{spec.detail}</dd>
                  </div>
                ))}
              </dl>
              <div className="landing__claim-callout">
                <p>
                  Claim it with the code on the box —<br />
                  no firmware flashing, no serial cable.
                </p>
                {/* The claim story is step 3 above; there is no separate hardware doc to link out to. */}
                <a className="landing__link-button" href="#how-it-works">
                  <KeyRound className="size-4" aria-hidden="true" /> See the claim flow
                </a>
              </div>
            </div>
          </div>
        </section>

        <section className="landing__section" aria-labelledby="features-title">
          <div className="landing__inner">
            <h2 className="eyebrow">What the control plane does</h2>
            <p className="landing__section-title" id="features-title">
              Everything between “send it” and “it ran”.
            </p>
            <div className="landing__features">
              {features.map((feature) => {
                const Icon = feature.icon;
                return (
                  <article key={feature.title}>
                    <div className="landing__feature-icon" aria-hidden="true">
                      <Icon />
                    </div>
                    <h3>{feature.title}</h3>
                    <p>{feature.body}</p>
                  </article>
                );
              })}
            </div>
          </div>
        </section>

        <section
          className="landing__section landing__section--sunken"
          id="pricing"
          aria-labelledby="pricing-title"
        >
          <div className="landing__inner">
            <h2 className="eyebrow">Pricing</h2>
            <p className="landing__section-title" id="pricing-title">
              You host the agent. We host the plumbing.
            </p>
            <div className="landing__tiers">
              {tiers.map((tier) => (
                <article
                  key={tier.name}
                  className="landing__tier"
                  data-featured={tier.featured || undefined}
                >
                  <div className="landing__tier-head">
                    <h3>{tier.name}</h3>
                    <span className="landing__tier-badge">{tier.badge}</span>
                  </div>
                  <p className="landing__tier-price">
                    {tier.price}
                    {tier.per ? <span>{tier.per}</span> : null}
                  </p>
                  <p className="landing__tier-blurb">{tier.blurb}</p>
                  <ul>
                    {tier.items.map((item) => (
                      <li key={item}>
                        <Check className="size-3.5 shrink-0" aria-hidden="true" />
                        <span>{item}</span>
                      </li>
                    ))}
                  </ul>
                  {tier.cta.kind === "signup" ? (
                    clerkReady ? (
                      <LandingButton
                        className="landing__tier-cta"
                        variant="primary"
                        disabled={checkingSession}
                        onClick={() => clerk?.openSignUp()}
                      >
                        {tier.cta.label}
                      </LandingButton>
                    ) : null
                  ) : tier.cta.kind === "anchor" ? (
                    <a className="landing__tier-cta landing__tier-cta--link" href={tier.cta.href}>
                      {tier.cta.label}
                    </a>
                  ) : (
                    <LandingButton className="landing__tier-cta" disabled title={tier.cta.note}>
                      {tier.cta.label}
                    </LandingButton>
                  )}
                </article>
              ))}
            </div>
          </div>
        </section>

        <section className="landing__section" id="faq" aria-labelledby="faq-title">
          <div className="landing__inner landing__faq">
            <div>
              <h2 className="eyebrow">FAQ</h2>
              <p className="landing__section-title" id="faq-title">
                The questions we actually get.
              </p>
            </div>
            <div className="landing__faq-list">
              {faq.map((entry) => (
                <div key={entry.id} id={entry.id}>
                  <h3>{entry.q}</h3>
                  <p>{entry.a}</p>
                </div>
              ))}
            </div>
          </div>
        </section>
      </main>

      <footer className="landing__footer">
        <div className="landing__inner landing__footer-inner">
          <div className="landing__footer-brand">
            <div className="brand-mark brand-mark--muted" aria-hidden="true">
              <BrandMark className="size-3.5" />
            </div>
            <span>Next Coder · self-hostable gateway · MIT firmware</span>
          </div>
          <MarketingSwitch current="home" />
          <p className="landing__footer-meta">Docs · Hardware protocol · Security · Status</p>
        </div>
      </footer>
    </div>
  );
}
