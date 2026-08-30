# Browser UI localization

## Problem

The Memory settings section used hard-coded English copy, so it did not follow the language selected by DSH Web.

## Decision

Register complete `zh` and `en` dictionaries with the Browser `locale` service under the `settings.memory` namespace. The settings navigation and component use the namespace-bound translator, and the slot declares that namespace so the renderer refreshes the surface when the DSH locale revision changes.

## Alternatives considered

- Read `navigator.language` or `localStorage` directly. This would bypass the durable DSH preference and would not reliably follow an in-app language change.
- Keep local React language state. This would duplicate Host-owned preference state and introduce a second language selector.

## Consequences

- The Browser client now requires the standard DSH locale plugin.
- English remains the fallback supplied by DSH when the selected locale has no value.
- Every new user-facing Memory UI string must be added to both dictionaries.
