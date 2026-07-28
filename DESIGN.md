# DESIGN.md — Pull Deck

The design record. Tokens live in `src/popup.css` under `:root`; this file explains *why* they hold those values.

## The scene that set the theme

An engineer glances at a 400px panel hanging off the Chrome toolbar, on a Retina display, at 3pm in a bright office and again at 11pm in a dim room, for three seconds at a time, ten times a day.

That scene forces **both themes, driven by the system**, not a choice between them. The popup is visually welded to Chrome's own toolbar; a dark panel on a light-themed browser reads as a rendering bug. So: `prefers-color-scheme`, fully designed in both directions, with dark mode built as its own design rather than an inversion.

## Register

**Product.** Design serves the task. Earned familiarity is the bar: an engineer fluent in Raycast, Linear, and macOS System Settings should sit down and trust it immediately. The tool disappears into the glance.

## Aesthetic lane: macOS system UI, honestly

"Apple styled" here means the actual grammar of macOS system surfaces, not a gradient-and-glass pastiche:

| Move | Implementation |
| --- | --- |
| System type | `-apple-system` / `BlinkMacSystemFont` stack; SF Pro on the target machine. Tracking tightened `-0.011em` at 13px+, `-0.006em` at 11–12px. |
| Grouped inset list | One rounded container holds all rows. Separators are inset hairlines that stop short of the container edge and vanish at the last row. This replaces card grids entirely. |
| Hairlines | `0.5px` on `min-resolution: 2dppx`, `1px` below. A real hairline, not a 1px border pretending. |
| No vibrancy at all | Tried and removed. Blur on the toolbar was decoration (nothing scrolls under it), and a translucent dock left rows half-visible behind it, which reads as a clipping bug in a 400px panel. Apple's grammar here is hairlines, grouped lists, and system type, not glass. |
| Scroll fade | The list's bottom edge is masked with a 34px gradient while more rows remain below, and unmasked once scrolled to the end. A row sliced by a scroll boundary looks broken; a row dissolving says "keep going". |
| Segmented control | Capsule track, sliding indicator driven by `translateX` off a CSS custom property. |
| Depth | Light mode gets shadows. Dark mode gets lighter surfaces and no shadows. |
| Icons | Hand-rolled 16px SVG set, 1.6px stroke, round caps and joins, on a 16-unit grid — SF Symbols geometry. One set, no mixing. |

## Color

**Strategy: Restrained.** Tinted neutrals carry the surface; the accent appears on the primary action, the active segment, focus rings, and the in-group indicator. Nowhere else.

**Accent: teal, `oklch(… 0.12 190)`.** Chosen against the reflexes: not Primer green (145), not Linear violet (295), not system blue (255). Hue 190 also sits clear of every semantic hue in use, so the accent never reads as a status.

Neutrals are tinted toward 190 at chroma `0.004–0.010` — enough for cohesion, below the threshold of looking colored. No `#000`, no `#fff`, no pure gray anywhere, including inside shadow and overlay colors.

**Dark-mode accent is boxed in from three sides** and the value is not free: the button label needs 4.5:1 against it (L ≤ 53.2%), and it must hold 3:1 against `--accent-quiet` for the in-group check (L ≥ 51.4%). `oklch(52.5% 0.125 190)` is inside that window. There is no *lighter* value that keeps the label readable, so dark-mode hover darkens instead of lightening — the one place this design inverts the usual convention, and it is forced rather than chosen.

Two related consequences, both measured rather than assumed. The progress fill is a **tinted dark scrim**, not a white wash: lightening the accent under a near-white label dropped it to 3.1:1 across the swept half, so the label had two different contrast ratios at once mid-animation. And the switch's off-state track stays light, with its **boundary** carrying the 3:1 rather than its fill — filling the track to 3:1 would make it far heavier than any real macOS switch, and WCAG 1.4.11 asks for a discernible boundary, not a dark one.

Semantic hues: success 150, danger 25, pending 75.

**Status is never color alone.** Review and CI state are the densest information in a row, and 8px dots at hue 190 and hue 150 are indistinguishable at a glance and worse under deuteranopia. Every state carries a **glyph plus a short word** — a check and "Approved", a slash-circle and "Changes", a dotted ring and "Pending". Color is the third signal, not the only one.

## Typography

One family, fixed rem scale, ratio ≈1.16. No fluid clamps: the popup is a fixed 400px and always viewed at the same DPI.

| Token | px | Use |
| --- | --- | --- |
| `--text-xs` | 11 | Badges, section labels, diffstat |
| `--text-sm` | 12 | Row metadata |
| `--text-base` | 13 | Row titles, buttons, body — macOS system body size |
| `--text-md` | 15 | Toolbar title |
| `--text-lg` | 19 | Onboarding and empty-state headings |

Counts and diffstats use `font-variant-numeric: tabular-nums` so a refresh doesn't make numbers jitter.

## Spacing

4pt base: 4 / 6 / 8 / 12 / 16 / 20 / 24 / 32. Rhythm is deliberately uneven — 12px inside a row, 16px at container edges, 20px between the toolbar and the list — because uniform padding everywhere is the monotony tell.

Window: **400 × 580**, inside Chrome's ~800×600 popup ceiling. Fixed height with internal scroll; the toolbar and footer stay put, only the list moves.

## Motion

Product timings: 150–250ms for nearly everything. `--ease-out-quart` is the default; `--ease-out-expo` for the one confident moment.

**The signature moment is the primary button, and it is driven by real events.** On click, the label crossfades to a progress state, a fill sweeps via `scaleX` (never `width`), and each row flips to "In group" *as its tab is actually created* — the sequence is the service worker reporting facts, not a timed animation. It resolves to "Added 5" with a stroke-drawn check, then settles back after 1.4s.

Supporting layer: rows enter on a 26ms stagger capped at 10 items, 240ms, fade plus 6px rise. The segmented indicator slides. View changes crossfade. Skeletons shimmer via `background-position`.

Nothing animates `width`, `height`, `top`, `left`, or margins.

Under `prefers-reduced-motion: reduce` the blanket rule **names its transition properties** (opacity, colour, border, shadow, visibility) rather than only shortening the duration. Leaving `transition-property` at its default of `all` does two wrong things at once: it hands a 140ms transition to every element that previously had none, and it leaves every existing `transform` transition running, merely faster. With the properties named, colour and opacity still crossfade while all movement snaps — the segment pill and the switch knob still travel to their new state, they just no longer slide there. Decorative transforms (press scale, hover scale, the view's 4px rise) are removed outright. The progress fill is the single exception and keeps its `scaleX`, because it reports how many tabs have actually opened.

## Component states

Every interactive element ships default / hover / focus-visible / active / disabled, and where it applies loading / error / success. Focus rings are 2px accent at 2px offset, `:focus-visible` only.

Views: `onboarding`, `loading` (skeleton), `list`, `empty`, `error`, `settings`. All six are real, reachable, and designed.
