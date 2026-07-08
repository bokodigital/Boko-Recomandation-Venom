---
name: Boko Reco app scopes & tracking delivery
description: Current OAuth scope set for the Boko AI Recommendations Shopify app, and the decision on how the click/add/purchase tracking script is delivered to storefronts.
---

The app's OAuth scopes (in `shopify.app.toml` and the `SCOPES` env var in `web/server.js`) are `write_discounts,read_orders,read_products` — no `write_script_tags`.

**Decision:** when asked to inject a site-wide tracking/attribution script via the Shopify ScriptTag API, the user declined to add the `write_script_tags` scope (this would require already-installed shops to re-consent via OAuth before the ScriptTag mutation would succeed for them). The user opted to load the tracking script via the theme (liquid extension) instead of ScriptTag injection.

**Why:** adding a new OAuth scope forces already-installed merchants to re-authorize before the feature works for them — a rollout cost the user wasn't willing to accept for this feature.

**How to apply:** don't propose ScriptTag-based delivery for future storefront-wide scripts on this app unless the user explicitly asks to revisit scopes. Client-side tracking/widget code for this app ships through the theme app extension (`extensions/reco-widget/`), not a ScriptTag.
