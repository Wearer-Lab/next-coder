import { fireEvent, render, screen, within } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { Radio, TerminalSquare } from "lucide-react";

import {
  CountUp,
  LandingButton,
  LandingNav,
  StatStrip,
  TrustRow,
  marketingPageLinks,
} from "./landingChrome";

const links = [
  { href: "#one", label: "One" },
  { href: "#two", label: "Two" },
];

test("the pill navigation marks the active section", () => {
  render(<LandingNav links={links} activeHref="#two" />);

  const active = screen.getByRole("link", { name: "Two" });
  expect(active).toHaveAttribute("data-active");
  expect(screen.getByRole("link", { name: "One" })).not.toHaveAttribute("data-active");
});

test("the burger opens the sheet, and Escape closes it again", () => {
  render(<LandingNav links={links} />);

  const burger = screen.getByRole("button", { name: "Open navigation" });
  expect(burger).toHaveAttribute("aria-expanded", "false");
  expect(screen.queryByRole("dialog", { name: "Navigation menu" })).not.toBeInTheDocument();

  fireEvent.click(burger);
  expect(screen.getByRole("dialog", { name: "Navigation menu" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Close navigation" })).toHaveAttribute(
    "aria-expanded",
    "true",
  );

  fireEvent.keyDown(window, { key: "Escape" });
  expect(screen.queryByRole("dialog", { name: "Navigation menu" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Open navigation" })).toHaveAttribute(
    "aria-expanded",
    "false",
  );
});

test("choosing a link in the sheet closes it", () => {
  render(<LandingNav links={links} />);

  fireEvent.click(screen.getByRole("button", { name: "Open navigation" }));
  const sheet = screen.getByRole("dialog", { name: "Navigation menu" });
  fireEvent.click(within(sheet).getByRole("link", { name: "One" }));

  expect(screen.queryByRole("dialog", { name: "Navigation menu" })).not.toBeInTheDocument();
});

test("the metric strip renders the value it will count up to", () => {
  render(<StatStrip stats={[{ glyph: "%", value: 99, decimals: 2, suffix: "%", label: "Uptime" }]} />);

  expect(screen.getByText("99.00%")).toBeInTheDocument();
  expect(screen.getByText("Uptime")).toBeInTheDocument();
});

test("the counter renders the final value before it animates", () => {
  render(<CountUp value={120} suffix="ms" className="value" />);

  expect(screen.getByText("120ms")).toBeInTheDocument();
});

test("the trust row carries the qualifier next to the surfaces", () => {
  render(
    <TrustRow icons={[TerminalSquare, Radio]}>MIT firmware</TrustRow>,
  );

  expect(screen.getByText("MIT firmware")).toBeInTheDocument();
});

test("the call to action reports its own busy and disabled state", () => {
  const onClick = vi.fn();
  const { rerender } = render(
    <LandingButton busy onClick={onClick}>
      Create your account
    </LandingButton>,
  );

  const button = screen.getByRole("button", { name: "Create your account" });
  expect(button).toBeDisabled();
  expect(button).toHaveAttribute("aria-busy", "true");

  rerender(
    <LandingButton onClick={onClick}>Create your account</LandingButton>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Create your account" }));
  expect(onClick).toHaveBeenCalledTimes(1);
});

// The cross-links must never offer the page the reader is already on.
test("the cross-links skip the current page", () => {
  expect(marketingPageLinks("developers").map((page) => page.href)).toEqual([
    "#/",
    "#/early-access",
  ]);
  expect(marketingPageLinks("home").map((page) => page.href)).toEqual([
    "#/developers",
    "#/early-access",
  ]);
});
