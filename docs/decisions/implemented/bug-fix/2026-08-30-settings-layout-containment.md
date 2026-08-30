# Settings layout containment

## Problem

The Memory section could exceed the Settings content width. Its padded root and long unbroken revision or root values contributed min-content width, forcing users to scroll horizontally.

## Decision

Keep the Memory surface inside its parent with border-box sizing, zero minimum widths, bounded child widths, and wrapping header, tabs, and actions. Continue using the Global revision for CAS writes, but do not render its SHA-256 value in the ordinary settings UI.

## Alternatives considered

- Hide horizontal overflow. This would conceal content without fixing the layout constraint.
- Shorten the displayed revision. It would still expose an implementation detail that users do not need for normal editing.

## Consequences

- Narrow Settings surfaces can wrap controls instead of growing wider than their parent.
- The full memory root remains visible and can break across lines.
- Revision conflicts remain enforced and localized even though the opaque revision is hidden.
