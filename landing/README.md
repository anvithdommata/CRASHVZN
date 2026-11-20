# CRASHVZN landing page

Marketing site for the CRASHVZN desktop app, built with Vite, React 19, TypeScript, and Tailwind CSS v4. Designed for `crashvzn.us`.

## Local development

```sh
cd landing
npm install
npm run dev
```

The dev server prints a local URL (default `http://localhost:5173`).

```sh
npm run build     # type-check + production build to dist/
npm run preview   # serve dist/ locally
```

## Downloads

The install buttons resolve automatically:

1. `VITE_DOWNLOAD_URL_MAC`, `VITE_DOWNLOAD_URL_WIN`, or `VITE_DOWNLOAD_URL_LINUX` from the build environment.
2. A platform-matching asset on the latest GitHub Release for `VITE_GITHUB_REPO` (default `anvithdommata/CRASHVZN`).
3. The repository's releases page.

Supported assets, in order of preference per platform:

| Platform | Extensions |
| --- | --- |
| macOS | `.dmg`, `.pkg`, `.zip` |
| Windows | `.exe`, `.msi`, `.zip` |
| Linux | `.AppImage`, `.deb`, `.rpm`, `.tar.gz` |

To point at a release other than the default repository, set `VITE_GITHUB_REPO=owner/repo` at build time. To point at a self-hosted binary, set the matching URL variable; files can live in `public/downloads/`.

```sh
VITE_DOWNLOAD_URL_MAC=/downloads/CRASHVZN-0.1.0-arm64.dmg npm run build
```

The page requests the latest release once per session and caches the result. When no release exists, the buttons link to the releases page rather than failing.

## Deploying to crashvzn.us

`public/CNAME` already contains `crashvzn.us`, and the build copies it to `dist/`. The site is a static SPA, so any static host works.

### GitHub Pages

1. Push the repository.
2. Run `npm run build` and publish `landing/dist` (for example with `gh-pages`, or a GitHub Actions workflow).
3. In the repository settings, set Pages to the publishing branch/folder.
4. At your DNS provider, add the GitHub Pages records for the apex domain:
   - `A` records to `185.199.108.153`, `185.199.109.153`, `185.199.110.153`, `185.199.111.153`
   - `AAAA` records to `2606:50c0:8000::153`, `2606:50c0:8001::153`, `2606:50c0:8002::153`, `2606:50c0::153`
5. Enable "Enforce HTTPS" once the certificate is issued.

### Cloudflare Pages / Netlify / Vercel

Use `landing` as the project root, `npm run build` as the build command, and `dist` as the output directory. Add `crashvzn.us` as a custom domain and follow the host's DNS instructions.

## Assets

- `public/media/crash-demo.mp4` — full 59.92 s reference incident used by the evidence player.
- `public/media/crash-inset.mp4` — 13 s excerpt of the impact used by the hero mock so the page does not download the full clip up front.
- `public/media/crash-poster.jpg` — poster frame for both videos.
- `public/og.png` — 1200×630 social preview image; `og.svg` is its editable source.
- `public/favicon.svg`, `public/apple-touch-icon.png` — site icons.

Replacing the demo clip? Keep the poster in sync and update the timing copy in `src/components/Evidence.tsx` if the reference incident changes.

## Structure

```
src/
  App.tsx                  page composition
  components/              each landing-page section
  lib/download.ts          platform detection + release resolution
  lib/hooks.ts             scroll/reveal helpers
  styles/                  tokens, shared UI, and per-section CSS
public/                    static assets, CNAME, robots.txt, sitemap.xml
```
