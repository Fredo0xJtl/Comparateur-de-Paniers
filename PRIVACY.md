# Privacy

Drive Price Splitter is designed as a local-first shopping comparison PWA.

## What Stays Local

- Products, shopping lists, stores, candidates, mock prices and settings are stored in the browser through IndexedDB.
- JSON backups are generated locally by the browser.
- Imports are read locally from the selected file.
- No account, backend, analytics, telemetry, crash reporting or remote font is required for the current release.

## Network Boundary

There is no backend, no account, no analytics, no telemetry and no crash reporting. The app never sends a shopping list, a basket, a price history or a backup anywhere.

Three network paths are allowed by policy, and only three. `npm run privacy:check` enforces this boundary in CI: any network primitive outside the declared modules, or any call to an undeclared host, fails the build.

| Path | Host | What leaves the device | When |
| --- | --- | --- | --- |
| PWA shell | same-origin only | nothing | service worker fetching static assets |
| Barcode lookup | `world.openfoodfacts.org` | the scanned barcode (EAN) alone | only when a scanned barcode is not already in the local database |
| Store search | `nominatim.openstreetmap.org` | the city name typed by the user, plus the store brand | only when the user runs a store search |

Both third-party services are public, free and account-less; neither receives an identifier, a list, a price or a basket. As with any HTTP request, they do see the device's IP address and can log it under their own policies ([Open Food Facts](https://world.openfoodfacts.org/privacy), [OpenStreetMap Foundation](https://osmfoundation.org/wiki/Privacy_Policy)). Store searches are rate-limited to one request per second to comply with the Nominatim usage policy.

Every other feature — comparison, shopping lists, history, backups — works fully offline.

### Drive collection (browser extension)

The optional connector extension drives the store's own website in a real browser tab, using the user's own session, exactly as a manual visit would. It holds host permissions for `leclercdrive.fr` and `coursesu.com` only, sends nothing to any third party, and stores its state in the browser's session storage. Opening a store website moves the user onto that store's own privacy policy.

The optional cart-fill flow can search products and click “Add to cart” in the supported store tabs, but only after a visible user action and explicit first-use consent. It does not submit an order, access payment or extract credentials. Manual product links remain available; once a store tab is opened, that retailer’s own privacy policy applies.

## Sensitive Data

Shopping lists and backups can reveal habits, preferred stores and prices. Treat exported JSON files as private files.

Do not publish real backups, screenshots containing personal shopping data, store credentials, cookies, sessions, payment data or private store URLs in issues or commits.

## Known Limits

- Browser storage is local but not guaranteed permanent. The browser or device can clear it.
- Backups are not encrypted in the current release.
- External store websites have their own privacy policies once opened manually.
