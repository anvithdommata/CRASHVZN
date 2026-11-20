# Download binaries

The site resolves downloads in this order:

1. `VITE_DOWNLOAD_URL_MAC`, `VITE_DOWNLOAD_URL_WIN`, or `VITE_DOWNLOAD_URL_LINUX` from the build environment.
2. A matching asset on the latest GitHub Release for `VITE_GITHUB_REPO` (default: `anvithdommata/CRASHVZN`).
3. The repository's releases page.

To host installers yourself, drop them in this folder and set the matching env var, for example:

```sh
VITE_DOWNLOAD_URL_MAC=/downloads/CRASHVZN-0.1.0-arm64.dmg
VITE_DOWNLOAD_URL_WIN=/downloads/CRASHVZN-0.1.0-setup.exe
VITE_DOWNLOAD_URL_LINUX=/downloads/CRASHVZN-0.1.0.AppImage
```

Keep large binaries out of git; attach them to a GitHub Release or upload them to your host's object storage.
