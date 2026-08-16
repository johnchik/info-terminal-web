# Info Terminal Web

Public, static web dashboard for the private **Info Terminal** backend.

The dashboard renders Bus ETA, Hong Kong weather, and Calendar data from an Info Terminal Information Core / Cloud Run deployment.

## Privacy

No backend token, calendar feed URL, or other user secret is stored in this repository. Runtime configuration is entered in the browser and stored only in that browser's `localStorage`. Calendar feed URLs are sent to the backend in `X-Calendar-ICal-*` request headers; the backend token is sent in `X-Info-Terminal-Token`.

## Development

Serve the repository root with any static HTTP server, for example:

```bash
python -m http.server 8000
```

Then open `http://localhost:8000` and configure the backend URL and token in Settings.

## GitHub Pages

The repository includes a GitHub Actions workflow that deploys the repository root to GitHub Pages.

Expected site URL: `https://johnchik.github.io/info-terminal-web/`
