import { LogIn, Radio, ShieldCheck, Smartphone, Sparkles } from "lucide-react";

import type { AuthConfig, ClerkBridge } from "../types";
import {
  LandingBackdrop,
  LandingButton,
  LandingNav,
  Shot,
  marketingPageLinks,
} from "./landingChrome";
import { SignInNotice, signInAvailability } from "./signInNotice";

interface DeveloperLandingPageProps {
  authConfig: AuthConfig;
  clerk: ClerkBridge | null;
}

const pipeline = [
  {
    n: "01",
    title: "Authenticate the operator",
    body: "Clerk owns identity; the gateway mints short-lived, user-scoped sessions and rate-limits per user, per device and per factory client.",
    route: "POST /v1/session",
  },
  {
    n: "02",
    title: "Screen the intent against policy",
    body: "Prompt, media, session control and shell input each carry a capability requirement and a risk score from the device's policy profile.",
    route: "POST /v1/intents",
  },
  {
    n: "03",
    title: "Hold risky work for approval",
    body: "A screened command stops at approval_required and raises a notification. Approve or reject from the console, the phone, or the controller.",
    route: "POST /v1/commands/:id/approve",
  },
  {
    n: "04",
    title: "Dispatch to your T3 host",
    body: "The gateway selects the session, resolves the harness and model from the live catalogue, and posts the orchestration request.",
    route: "POST /v1/environments/:id/dispatch",
  },
  {
    n: "05",
    title: "Keep the receipt",
    body: "Every transition is recorded with actor, previous status and result — the same timeline support sees in a redacted export.",
    route: "GET /v1/commands/:id/events",
  },
];

/**
 * The terminal transcript is illustrative, not captured output: the host name, the setup code and
 * the environment id are stand-ins. Everything it *claims* — the command, the ordering of the
 * steps, the shape of the ids — matches what `scripts/setup-t3.mjs` actually prints.
 */
function SetupTranscript() {
  return (
    <div className="devland__terminal">
      <div className="devland__terminal-bar">
        <span className="devland__dot" data-tone="danger" aria-hidden="true" />
        <span className="devland__dot" data-tone="warning" aria-hidden="true" />
        <span className="devland__dot" data-tone="success" aria-hidden="true" />
        <span className="devland__terminal-title">dana@studio — zsh</span>
        <span className="devland__paired">
          <span aria-hidden="true" />
          paired
        </span>
      </div>
      <pre>
        <span className="devland__hash"># </span>
        <span className="devland__comment">on the machine already running T3 Code</span>
        {"\n"}
        <span className="devland__prompt">$</span>
        {" NEXT_CODER_URL=https://gateway.nextcoder.dev \\\n    SETUP_CODE=7QK2-M4XP npm run setup:t3\n\n"}
        <span className="devland__arrow">→</span>
        {" reached T3 Code at http://127.0.0.1:4381\n"}
        <span className="devland__arrow">→</span>
        {" registered environment  env_7k3p1nzq  \"Studio Mac mini\"\n"}
        <span className="devland__arrow">→</span>
        {" catalogued harnesses    codex (6 models), claude-code (4)\n"}
        <span className="devland__arrow">→</span>
        {" snapshot                2 projects · 3 threads\n"}
        <span className="devland__ok">✓</span>
        {" paired. open https://gateway.nextcoder.dev"}
      </pre>
    </div>
  );
}

/**
 * The terminal-first cut of the front door, for someone who already runs T3 Code and wants to see
 * the command before the pitch. Same tokens and same claims as the main landing page — it leads
 * with the setup transcript instead of a product shot, and holds the account CTA to the end.
 */
export function DeveloperLandingPage({ authConfig, clerk }: DeveloperLandingPageProps) {
  const signIn = signInAvailability(authConfig, clerk);
  const clerkReady = signIn === "ready";
  const checkingSession = clerkReady && !clerk?.loaded;

  const accountActions = clerkReady ? (
    <div className="landing__actions">
      <LandingButton size="lg" variant="primary" disabled={checkingSession} onClick={() => clerk?.openSignUp()}>
        <Sparkles className="size-4" />
        {checkingSession ? "Checking session…" : "Create your account"}
      </LandingButton>
      <LandingButton size="lg" variant="secondary" disabled={checkingSession} onClick={() => clerk?.openSignIn()}>
        I already have one
      </LandingButton>
    </div>
  ) : (
    // No account door on this page. The reason is stated, and a gateway that did not answer gets
    // its own reason rather than being told its Clerk keys are missing.
    <SignInNotice availability={signIn} />
  );

  return (
    <div className="landing devland">
      <LandingBackdrop />

      <LandingNav
        links={marketingPageLinks("developers")}
        actions={
          clerkReady ? (
            <LandingButton variant="dark" size="sm" disabled={checkingSession} onClick={() => clerk?.openSignIn()}>
              <LogIn className="size-4" /> Sign in
            </LandingButton>
          ) : null
        }
      />

      <main className="landing__main" id="main-content">
        <section className="landing__section devland__hero">
          <div className="landing__inner landing__inner--narrow">
            <p className="devland__command">$ npm run setup:t3</p>
            <h1>Your agent stays home. The controls come with you.</h1>
            <p className="landing__lede">
              One command on the machine already running T3 Code. After that you can dispatch
              prompts, shell input, camera frames and voice from a browser, a phone, or a knob on
              your desk — with a policy gate in front of anything destructive.
            </p>

            <SetupTranscript />

            {accountActions}

            <p className="landing__reassure">
              <ShieldCheck className="size-3.5 shrink-0" aria-hidden="true" />
              Gateway is self-hostable. Provider credentials never leave your machine.
            </p>
          </div>
        </section>

        <section className="landing__section" aria-labelledby="pipeline-title">
          <div className="landing__inner landing__inner--narrow">
            <h2 className="eyebrow" id="pipeline-title">
              What the gateway is responsible for
            </h2>
            <ol className="devland__pipeline">
              {pipeline.map((stage) => (
                <li key={stage.n}>
                  <span className="devland__pipeline-n" aria-hidden="true">
                    {stage.n}
                  </span>
                  <div>
                    <h3>{stage.title}</h3>
                    <p>{stage.body}</p>
                  </div>
                  <code>{stage.route}</code>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section className="landing__section">
          <div className="landing__inner landing__inner--narrow devland__split">
            <article>
              <div className="landing__step-icon" aria-hidden="true">
                <Smartphone className="size-4" />
              </div>
              <h3>Browser-only is a complete setup</h3>
              <p>
                Push-to-talk, camera prompts, approvals and macros all work from the PWA at 375px.
                Hardware is an addition, never a requirement.
              </p>
            </article>
            <article>
              <div className="landing__feature-icon" aria-hidden="true">
                <Radio className="size-4" />
              </div>
              <h3>Or claim the controller</h3>
              <p>
                ESP32, 2.13" e-ink, one rotary encoder. Claim it with a code, point it at a thread,
                and it polls compact display state over WiFi.
              </p>
              <Shot icon={Radio} ratio="16 / 7" caption="controller, front view" />
              <a className="landing__link-button" href="#/early-access">
                See the hardware
              </a>
            </article>
          </div>
        </section>

        <section className="landing__section devland__close">
          <div className="landing__inner landing__inner--narrow">
            <h2>Pair a host, get a thread that answers.</h2>
            <p>Free while it's nightly. Bring your own provider keys; they stay on your machine.</p>
            {accountActions}
            <p className="devland__wordmark">
              gateway.nextcoder.dev · self-host · MIT firmware
            </p>
          </div>
        </section>
      </main>
    </div>
  );
}
