import mark from "./brandMark.json";

/**
 * The Next Coder mark: a prompt caret and its cursor bar, drawn as two strokes.
 *
 * The geometry lives in `brandMark.json` so the icon generator
 * (`frontend/scripts/generate-icons.mjs`) and this component draw the same
 * shape. There is one mark in the product — the sidebar, the marketing header
 * and the installed app icon are the same glyph on different grounds.
 *
 * The glyph inherits `currentColor`, so a surface chooses the ink: white on the
 * black app icon, ink on the white disc the console and the marketing pages
 * use.
 */
function toPath(points: number[][]): string {
  return points.map(([x, y], index) => `${index === 0 ? "M" : "L"}${x} ${y}`).join(" ");
}

export function BrandMark({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox={mark.viewBox}
      fill="none"
      stroke="currentColor"
      strokeWidth={mark.strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={toPath(mark.chevron)} />
      <path d={toPath([[mark.bar[0], mark.bar[1]], [mark.bar[2], mark.bar[3]]])} />
    </svg>
  );
}
