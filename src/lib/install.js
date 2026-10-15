import { sortVersionsDesc } from '../../shared/version.js';

// Turning an edge app on GitHub into an installable version in IoT Open, without the user seeing app.json or
// app.lua. The IoT Open app is found again by its source_url (the GitHub repository), so every installation
// in the organization shares one app, and each GitHub release becomes one named version.

export const normUrl = (u) =>
  String(u || '')
    .trim()
    .toLowerCase()
    .replace(/\.git$/, '')
    .replace(/\/+$/, '');

/** "https://github.com/owner/repo" -> { owner, repo }, else null. */
export function githubRepo(sourceUrl) {
  const m = /^https:\/\/github\.com\/([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?\/?$/i.exec(String(sourceUrl || '').trim());
  return m ? { owner: m[1], repo: m[2] } : null;
}

/** Newest named version of an IoT Open app, or null. */
export const latestVersion = (versions) => sortVersionsDesc((versions || []).filter((v) => v.name), (v) => v.name)[0] || null;

const META_KEYS = ['name', 'short_description', 'description', 'tags', 'category', 'source_url'];
const sameMeta = (app, meta) => META_KEYS.every((k) => JSON.stringify(app[k] ?? null) === JSON.stringify(meta[k] ?? null));

export class InstallError extends Error {}

/**
 * Makes sure the GitHub package (from the backend) exists as a named version in IoT Open.
 * Returns { app, version }. onStep(text) reports progress.
 */
export async function ensureGithubVersion(lynx, { orgId, pkg, onStep = () => {} }) {
  onStep('Letar efter appen i IoT Open…');
  const own = (await lynx.edgeAppsOrganization(orgId)) || [];
  let app = own.find((a) => normUrl(a.source_url) === normUrl(pkg.meta.source_url));

  if (!app) {
    onStep('Skapar appen i IoT Open…');
    // the publisher is the organization (publisher.id = organization id)
    const publisher = await lynx.edgePublisher(orgId).catch(() => ({ id: orgId }));
    try {
      app = await lynx.createEdgeApp({ ...pkg.meta, publisher: { id: publisher.id ?? orgId }, public: false });
    } catch (e) {
      if (e.status === 403 || e.status === 401) {
        throw new InstallError(`Ditt konto får inte publicera edge apps för organisationen i IoT Open (${e.message}). Be en administratör ge dig rätt till det.`);
      }
      throw e;
    }
  } else if (!sameMeta(app, pkg.meta)) {
    // name, description and tags follow GitHub; a failure here does not stop the installation
    try {
      app = (await lynx.updateEdgeApp({ ...app, ...pkg.meta })) || app;
    } catch (e) {
      console.warn('could not update edge app description', e);
    }
  }

  const versions = (await lynx.edgeAppVersions(app.id)) || [];
  if (versions.some((v) => v.name === pkg.version)) return { app, version: pkg.version };

  onStep(`Laddar upp version ${pkg.version}…`);
  const res = await lynx.createEdgeAppVersion(app.id, pkg.appJson, pkg.appLua);
  let hash = res && typeof res === 'object' ? res.hash : null;
  if (!hash) {
    // 204: the files are identical to the latest upload. If that one already has a name, the GitHub release only
    // re-tagged the same code - use that version. Otherwise name it now.
    const all = (await lynx.edgeAppVersions(app.id, true)) || [];
    const latest = [...all].sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))[0];
    if (latest?.name) return { app, version: latest.name, sameAs: pkg.version };
    hash = latest?.hash;
  }
  if (!hash) throw new InstallError('IoT Open tog emot versionen men svarade inte med någon identitet (hash).');

  onStep(`Publicerar version ${pkg.version}…`);
  try {
    await lynx.publishEdgeAppVersion(app.id, pkg.version, hash);
  } catch (e) {
    // someone else published the same version at the same time
    const again = (await lynx.edgeAppVersions(app.id)) || [];
    if (!again.some((v) => v.name === pkg.version)) throw e;
  }
  return { app, version: pkg.version };
}
