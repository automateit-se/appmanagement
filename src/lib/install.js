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

/** "Skapar appen i IoT Open: Internal Server Error (HTTP 500 på POST /api/v2/edge/app)" */
const failedAt = (step, e) => {
  const where = e?.status ? ` (HTTP ${e.status}${e.path ? ` på ${e.method || 'GET'} ${String(e.path).split('?')[0]}` : ''})` : '';
  return new InstallError(`${step.replace(/…$/, '')}: ${e?.message || e}${where}`);
};

/**
 * Makes sure the GitHub package (from the backend) exists as a named version in IoT Open.
 * Returns { app, version }. onStep(text) reports progress.
 */
export async function ensureGithubVersion(lynx, opts) {
  // which step failed is part of the message: IoT Open's own errors often say only "Internal Server Error"
  let step = 'Letar efter appen i IoT Open…';
  const at = (s) => {
    step = s;
    opts.onStep?.(s);
  };
  try {
    return await ensureVersion(lynx, { ...opts, onStep: at });
  } catch (e) {
    throw e instanceof InstallError ? e : failedAt(step, e);
  }
}

async function ensureVersion(lynx, { orgId, pkg, onStep = () => {} }) {
  onStep('Letar efter appen i IoT Open…');
  const own = (await lynx.edgeAppsOrganization(orgId)) || [];
  let app = own.find((a) => normUrl(a.source_url) === normUrl(pkg.meta.source_url));

  if (!app) {
    onStep('Skapar appen i IoT Open…');
    // the publisher is the organization (publisher.id = organization id)
    const publisher = await lynx.edgePublisher(orgId).catch(() => ({ id: orgId }));
    const create = (meta) => lynx.createEdgeApp({ ...meta, publisher: { id: publisher.id ?? orgId }, public: false });
    try {
      app = await create(pkg.meta);
    } catch (e) {
      if (e.status === 403 || e.status === 401) {
        throw new InstallError(`Ditt konto får inte publicera edge apps för organisationen i IoT Open (${e.message}). Be en administratör ge dig rätt till det.`);
      }
      if (!(e.status >= 500)) throw e;
      // IoT Open answers 500 for some descriptions (a long one, for instance): once more with only the short one
      const short = [pkg.meta.short_description, pkg.meta.source_url].filter(Boolean).join('\n\n');
      try {
        app = await create({ ...pkg.meta, description: short });
      } catch {
        throw e;
      }
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
