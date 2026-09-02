# Security Policy

## Scope

Drive Price Splitter is a local-first shopping comparison PWA. It stores data in IndexedDB and does not require an application account, backend, telemetry, analytics, remote scripts or external fonts. Its optional browser extension can visibly automate price collection and cart filling on the supported store websites after a user action.

See `PRIVACY.md` for the user-facing privacy boundary and known limits.

## Privacy and Network Boundaries

- No application network request is allowed by default.
- Product, list, store, candidate, price, settings, export and import data stay local to the device.
- JSON backups can reveal shopping habits and should be treated as sensitive local files.
- The optional connector may use the store session already open in the browser to collect prices and fill a cart after explicit consent.
- It must never automate login, payment, checkout or order confirmation, and must never extract cookies or credentials.

## Supported Checks

Run these before publishing changes:

```bash
npm run test
npm run typecheck
npm run privacy:check
npm run build
```

`npm run privacy:check` scans production source for blocked network primitives outside the service worker allowlist.

## Reporting Issues

For now, report security or privacy issues through GitHub Issues without including personal shopping data, real backups, cookies, sessions, payment data or sensitive screenshots.

If the report needs examples, use mock data only.

## Known Limits

- Local browser storage can be cleared by the browser or device policies.
- Backups are not encrypted in V1.
- Price evidence may come from local demo data or from a visible connector run on the supported store sites.
- Store tabs and their existing sessions remain inside each retailer's privacy boundary.
