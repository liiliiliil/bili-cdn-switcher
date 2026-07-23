# Contributing

Thanks for helping improve Bili CDN Switcher.

## Before opening an issue

- Confirm the extension version shown at the bottom of the popup.
- Test once with the extension disabled to separate CDN behavior from unrelated player, proxy or network issues.
- Do not post complete signed media URLs, cookies, account identifiers or screenshots containing private information.
- Include the Bilibili video ID, approximate region, selected quality, observed CDN host, target CDN host and recovery count when they are relevant.

## Development

Requirements:

- Node.js 18 or newer
- A Chromium browser that supports Manifest V3

Run the automated checks:

```bash
npm run check
```

For manual testing, load the repository root as an unpacked extension from `chrome://extensions`. Test only public media you are authorized to view.

## Pull requests

- Keep the extension's single purpose: locally optimize Bilibili on-demand video CDN selection.
- Do not add telemetry, advertising, remote code, proxy behavior, region bypassing or access to unrelated websites.
- Keep permissions and host access as narrow as possible.
- Add or update tests for behavior changes.
- Explain the user-visible effect and the Chrome APIs involved.
