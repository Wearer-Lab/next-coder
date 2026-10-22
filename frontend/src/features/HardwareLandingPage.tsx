import {
  ArrowRight,
  Check,
  CircleDot,
  KeyRound,
  Mail,
  Monitor,
  Radio,
  TerminalSquare,
  Wifi,
  type LucideIcon,
} from "lucide-react";
import { useState, type FormEvent } from "react";

import type { AuthConfig, ClerkBridge } from "../types";
import {
  LandingBackdrop,
  LandingButton,
  LandingNav,
  Shot,
  marketingPageLinks,
} from "./landingChrome";
import { SignInNotice, signInAvailability } from "./signInNotice";

interface HardwareLandingPageProps {
  authConfig: AuthConfig;
  clerk: ClerkBridge | null;
  /**
   * Records an interest email. There is no gateway endpoint for this yet, so App does not pass one
   * and the form renders in its explained-unavailable state. Supplying it turns the form live —
   * that is the whole seam a real waitlist backend needs.
   */
  onRequestUnit?: (email: string) => Promise<void>;
}

/**
 * Batch facts as the design copy states them. These are marketing claims, not values the gateway
 * knows — `unitsReserved` in particular asserts something about real demand. Keep them here so
 * they are edited in one place, and check them before this page is public.
 */
const batch = {
  label: "BATCH 01 · 250 UNITS",
  unitsReserved: "184",
  firstShipments: "Oct",
  price: "$129",
};

const specs: Array<{ icon: LucideIcon; title: string; body: string }> = [
  {
    icon: Monitor,
    title: "2.13in e-ink",
    body: "Partial refresh with a full pass every eight frames. Readable with the room lights off.",
  },
  {
    icon: CircleDot,
    title: "One EC11 encoder",
    body: "Turn to move the menu, press to send the intent. No modes to remember.",
  },
  {
    icon: Wifi,
    title: "ESP32 over WiFi",
    body: "Polls compact display state and posts menu intents. Signed OTA updates.",
  },
  {
    icon: KeyRound,
    title: "Per-device secret",
    body: "Rotatable and revocable from the console. Never carries a provider credential.",
  },
];

const inTheBox = [
  <>Controller, pre-provisioned with a per-device secret</>,
  <>
    Printed claim card — <code>ABCDE-23456</code>
  </>,
  <>USB-C cable, signed OTA enabled after your first update</>,
  <>Transfer reset, so the unit can change hands cleanly</>,
];

function RequestUnitForm({ onRequestUnit }: { onRequestUnit?: (email: string) => Promise<void> }) {
  const [email, setEmail] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "done" | "error">("idle");

  if (!onRequestUnit) {
    // The design's primary action, with nothing behind it. Showing the field disabled and saying
    // so beats collecting an address the gateway would silently drop.
    return (
      <div className="hardland__capture">
        <div className="hardland__capture-row">
          <input type="email" placeholder="you@yourcompany.com" disabled aria-label="Email address" />
          <LandingButton variant="primary" disabled title="Reservations are not open yet.">
            Request a unit
            <ArrowRight className="size-4" aria-hidden="true" />
          </LandingButton>
        </div>
        <p className="hardland__capture-note" role="status">
          <Mail className="size-3.5 shrink-0" aria-hidden="true" />
          Reservations are not open yet — this gateway has nowhere to record one.
        </p>
      </div>
    );
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!email.trim() || state === "sending") return;
    setState("sending");
    try {
      await onRequestUnit!(email.trim());
      setState("done");
    } catch {
      setState("error");
    }
  }

  return (
    <form className="hardland__capture" onSubmit={submit}>
      {state === "done" ? (
        <p className="hardland__capture-done" role="status">
          <Check className="size-4 shrink-0" aria-hidden="true" />
          You're on the list for batch 01. We'll email {email} when it ships.
        </p>
      ) : (
        <>
          <div className="hardland__capture-row">
            <input
              type="email"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="you@yourcompany.com"
              aria-label="Email address"
            />
            <LandingButton type="submit" variant="primary" busy={state === "sending"}>
              Request a unit
              <ArrowRight className="size-4" aria-hidden="true" />
            </LandingButton>
          </div>
          <p className="hardland__capture-note">
            <Mail className="size-3.5 shrink-0" aria-hidden="true" />
            {state === "error"
              ? "That did not go through. Try again in a moment."
              : "One email when your unit ships. Nothing else, ever."}
          </p>
        </>
      )}
    </form>
  );
}

/**
 * The device-led cut of the front door: one screen, hardware first, email capture instead of an
 * account. Someone who wants software today is pointed at the console section at the bottom.
 */
export function HardwareLandingPage({ authConfig, clerk, onRequestUnit }: HardwareLandingPageProps) {
  const signIn = signInAvailability(authConfig, clerk);
  const clerkReady = signIn === "ready";
  const checkingSession = clerkReady && !clerk?.loaded;

  return (
    <div className="landing hardland">
      <LandingBackdrop />

      <LandingNav
        links={marketingPageLinks("early-access")}
        actions={<span className="hardland__batch">{batch.label}</span>}
      />

      <main className="landing__main" id="main-content">
        <section className="landing__section hardland__hero">
          <div className="landing__inner hardland__hero-grid">
            <div>
              <p className="eyebrow eyebrow--accent">Early access</p>
              <h1>A knob for the agent that's already running.</h1>
              <p className="landing__lede">
                Two hundred and fifty units of the first hardware controller. E-ink face, one
                encoder, and a claim code on the box. It talks to your own T3 Code host through the
                Next Coder gateway — never to us.
              </p>

              <RequestUnitForm onRequestUnit={onRequestUnit} />

              <dl className="hardland__stats">
                <div>
                  <dd>{batch.unitsReserved}</dd>
                  <dt>units reserved</dt>
                </div>
                <div>
                  <dd>{batch.firstShipments}</dd>
                  <dt>first shipments</dt>
                </div>
                <div>
                  <dd>{batch.price}</dd>
                  <dt>batch-01 price</dt>
                </div>
              </dl>
            </div>

            <div className="hardland__hero-media">
              <Shot icon={Radio} ratio="4 / 3" caption="hero shot — controller, three-quarter view" />
              <div className="hardland__eink-card">
                <p className="eyebrow">On the e-ink face</p>
                <div className="hardland__eink" aria-label="Simulated controller screen">
                  <p>next-coder</p>
                  <p>▸ approve shell input</p>
                  <p>2 waiting · gpt-5.4 · 86%</p>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className="landing__section" aria-label="Controller specifications">
          <div className="landing__inner hardland__specs">
            {specs.map((spec) => {
              const Icon = spec.icon;
              return (
                <article key={spec.title}>
                  <div className="landing__step-icon" aria-hidden="true">
                    <Icon />
                  </div>
                  <h3>{spec.title}</h3>
                  <p>{spec.body}</p>
                </article>
              );
            })}
          </div>
        </section>

        <section className="landing__section" aria-labelledby="no-hardware-title">
          <div className="landing__inner hardland__closer">
            <div>
              <p className="eyebrow eyebrow--accent">No hardware</p>
              <h2 id="no-hardware-title">No hardware? Still works.</h2>
              <p>
                The gateway and the web console are available now, free while nightly. Pair a T3
                Code host, run a thread, approve from your phone. The controller only replaces the
                phone for the thread you keep coming back to.
              </p>
              {clerkReady ? (
                <LandingButton
                  size="lg"
                  variant="secondary"
                  disabled={checkingSession}
                  onClick={() => clerk?.openSignUp()}
                >
                  <TerminalSquare className="size-4" />
                  Use the console instead
                </LandingButton>
              ) : (
                <a className="landing__link-button" href="#/developers">
                  <TerminalSquare className="size-4" aria-hidden="true" />
                  See how the console works
                </a>
              )}
              {/* Without an account door the console path is a dead end, so the reason is stated. */}
              {clerkReady ? null : <SignInNotice availability={signIn} />}
            </div>
            <div className="hardland__box">
              <p className="eyebrow">What ships in the box</p>
              <ul>
                {inTheBox.map((item, index) => (
                  <li key={index}>
                    <Check className="size-3.5 shrink-0" aria-hidden="true" />
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </section>
      </main>

      <footer className="landing__footer">
        <div className="landing__inner landing__footer-inner">
          <span>Next Coder · batch 01</span>
          <p className="landing__footer-meta">Docs · Hardware protocol · Security</p>
        </div>
      </footer>
    </div>
  );
}
