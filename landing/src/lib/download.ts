import { useEffect, useState } from "react";

export type DownloadTarget = {
  url: string;
  version: string;
  /** True when a release asset was found (rather than only the releases page). */
  direct: boolean;
};

const DEFAULT_REPO = "anvithdommata/CRASHVZN";
const repo = import.meta.env.VITE_GITHUB_REPO?.trim() || DEFAULT_REPO;
const version = import.meta.env.VITE_DOWNLOAD_VERSION?.trim() || "0.1.0";
const override = import.meta.env.VITE_DOWNLOAD_URL?.trim();

const releasesPage = `https://github.com/${repo}/releases`;
// `/releases/latest` returns 404 until the first release exists. The collection
// endpoint returns an empty array instead, so unpublished repos fall back cleanly.
const apiUrl = `https://api.github.com/repos/${repo}/releases?per_page=1`;
const cacheKey = `crashvzn:latest-release:${repo}`;

type GithubAsset = { name: string; browser_download_url: string };
type GithubRelease = { tag_name?: string; html_url?: string; assets?: GithubAsset[] };

let releaseRequest: Promise<GithubRelease | null> | null = null;

function latestRelease(): Promise<GithubRelease | null> {
  if (releaseRequest) return releaseRequest;

  releaseRequest = (async () => {
    const cached = sessionStorage.getItem(cacheKey);
    if (cached) {
      try {
        return JSON.parse(cached) as GithubRelease;
      } catch {
        sessionStorage.removeItem(cacheKey);
      }
    }

    try {
      const response = await fetch(apiUrl, { headers: { Accept: "application/vnd.github+json" } });
      if (!response.ok) return null;
      const releases = (await response.json()) as GithubRelease[];
      const release = Array.isArray(releases) ? releases[0] ?? null : null;
      if (release) sessionStorage.setItem(cacheKey, JSON.stringify(release));
      return release;
    } catch {
      return null;
    }
  })();

  return releaseRequest;
}

/** Prefer a desktop installer asset when one exists; otherwise the release page. */
function pickUniversalUrl(release: GithubRelease): string | null {
  const assets = release.assets ?? [];
  const ranked = assets
    .map((asset) => {
      const lower = asset.name.toLowerCase();
      if (/\.dmg$|\.pkg$|\.exe$|\.msi$|\.appimage$/.test(lower)) return { asset, score: 100 };
      if (/\.deb$|\.rpm$|\.zip$|\.tar\.gz$/.test(lower)) return { asset, score: 40 };
      return { asset, score: -1 };
    })
    .filter((entry) => entry.score >= 0)
    .sort((a, b) => b.score - a.score);

  if (ranked[0]) return ranked[0].asset.browser_download_url;
  return release.html_url ?? null;
}

export function useDownloadTarget() {
  const [target, setTarget] = useState<DownloadTarget>(() => ({
    url: override || releasesPage,
    version,
    direct: Boolean(override),
  }));

  useEffect(() => {
    if (override) return;

    let cancelled = false;
    void latestRelease().then((release) => {
      if (cancelled || !release) return;
      const url = pickUniversalUrl(release) || releasesPage;
      setTarget({
        url,
        version: (release.tag_name ?? version).replace(/^v/i, ""),
        direct: Boolean(release.assets?.length),
      });
    });

    return () => {
      cancelled = true;
    };
  }, []);

  return target;
}
