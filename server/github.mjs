import { HttpError, ttlCache } from './http.mjs';
import { sortVersionsDesc, versionName } from '../shared/version.js';

// Edge apps on GitHub. A repository is an edge app for App Management when it
//   - has the topic GITHUB_TOPIC (default "iotopen-edge-app"),
//   - has app.lua and app.json in the root, and
//   - has at least one release (or tag): each release is a version in IoT Open.
// Name, short description, description (README.md) and tags come from the repository itself, so nothing has
// to be written by hand in IoT Open. Only public data is read; GITHUB_TOKEN only raises GitHub's rate limit.

const NAME = /^[A-Za-z0-9-]{1,39}$/;
const REPO = /^[A-Za-z0-9._-]{1,100}$/;
const TAG = /^[A-Za-z0-9._\/-]{1,100}$/;
const MAX_FILE = 512 * 1024;
const MAX_README = 20000;

export const prettyName = (repo) => {
  const s = String(repo).replace(/[-_]+/g, ' ').trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
};

export function githubClient(cfg) {
  const gh = cfg.github;
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'appmanagement',
    'X-GitHub-Api-Version': '2022-11-28',
    ...(gh.token ? { Authorization: `Bearer ${gh.token}` } : {}),
  };

  async function get(url, { raw = false, optional = false } = {}) {
    let r;
    try {
      r = await fetch(url, { headers: raw ? { 'User-Agent': headers['User-Agent'] } : headers, signal: AbortSignal.timeout(20_000) });
    } catch (e) {
      throw new HttpError(502, `Kunde inte nå GitHub: ${e.message}`);
    }
    if (r.status === 404 && optional) return null;
    if (r.status === 403 || r.status === 429) {
      throw new HttpError(503, 'GitHub begränsar antalet anrop just nu. Försök igen om en stund, eller ge tjänsten en GITHUB_TOKEN.');
    }
    if (r.status === 404) throw new HttpError(404, 'Hittades inte på GitHub');
    if (!r.ok) throw new HttpError(502, `GitHub svarade HTTP ${r.status}`);
    if (!raw) return r.json();
    const len = Number(r.headers.get('content-length') || 0);
    if (len > MAX_FILE) throw new HttpError(422, 'Filen på GitHub är för stor');
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > MAX_FILE) throw new HttpError(422, 'Filen på GitHub är för stor');
    return buf.toString('utf8');
  }

  const trusted = (owner) => !gh.owners.length || gh.owners.some((o) => o.toLowerCase() === String(owner).toLowerCase());

  const summary = (r) => ({
    id: r.full_name,
    owner: r.owner?.login,
    repo: r.name,
    name: prettyName(r.name),
    description: r.description || '',
    topics: (r.topics || []).filter((t) => t !== gh.topic),
    stars: r.stargazers_count || 0,
    updated: r.pushed_at || r.updated_at || null,
    url: r.html_url,
    license: r.license?.spdx_id || null,
    archived: !!r.archived,
  });

  function checkNames(owner, repo) {
    if (!NAME.test(owner) || !REPO.test(repo)) throw new HttpError(400, 'Ogiltigt repositorynamn');
    if (!trusted(owner)) throw new HttpError(404, 'Repositoryt är inte godkänt i den här installationen av App Management');
  }

  const listCache = ttlCache(5 * 60_000, 10);
  const detailCache = ttlCache(5 * 60_000, 200);
  const packageCache = ttlCache(60 * 60_000, 200);

  async function catalog() {
    return listCache('all', async () => {
      const q = [`topic:${gh.topic}`, 'archived:false', ...gh.owners.map((o) => `user:${o}`)].join(' ');
      const res = await get(`${gh.apiUrl}/search/repositories?q=${encodeURIComponent(q)}&sort=updated&per_page=100`);
      return (res.items || []).filter((r) => trusted(r.owner?.login)).map(summary);
    });
  }

  async function versions(owner, repo) {
    const rel = await get(`${gh.apiUrl}/repos/${owner}/${repo}/releases?per_page=50`);
    let list = (rel || [])
      .filter((r) => !r.draft && (gh.prereleases || !r.prerelease) && TAG.test(r.tag_name || ''))
      .map((r) => ({ tag: r.tag_name, name: versionName(r.tag_name), published: r.published_at, notes: String(r.body || '').slice(0, 4000), prerelease: !!r.prerelease }));
    if (!list.length) {
      const tags = await get(`${gh.apiUrl}/repos/${owner}/${repo}/tags?per_page=50`);
      list = (tags || []).filter((t) => TAG.test(t.name || '')).map((t) => ({ tag: t.name, name: versionName(t.name), published: null, notes: '', prerelease: false }));
    }
    return sortVersionsDesc(list, (v) => v.name);
  }

  async function details(owner, repo) {
    checkNames(owner, repo);
    return detailCache(`${owner}/${repo}`.toLowerCase(), async () => {
      const r = await get(`${gh.apiUrl}/repos/${owner}/${repo}`);
      if (!(r.topics || []).includes(gh.topic)) throw new HttpError(404, `Repositoryt saknar topic ${gh.topic}`);
      if (!trusted(r.owner?.login)) throw new HttpError(404, 'Repositoryt är inte godkänt i den här installationen av App Management');
      const vs = await versions(r.owner.login, r.name);
      const readme = vs.length ? await get(`${gh.rawUrl}/${r.owner.login}/${r.name}/${vs[0].tag}/README.md`, { raw: true, optional: true }) : null;
      return { ...summary(r), versions: vs, readme: readme ? readme.slice(0, MAX_README) : '' };
    });
  }

  /** Everything IoT Open needs for one version: the two files and the app's description. */
  async function pkg(owner, repo, tag) {
    if (!TAG.test(String(tag || '')) || String(tag).includes('..')) throw new HttpError(400, 'Ogiltig version');
    const d = await details(owner, repo);
    const v = d.versions.find((x) => x.tag === tag);
    if (!v) throw new HttpError(404, `Versionen ${tag} finns inte på GitHub`);
    return packageCache(`${d.id}@${tag}`.toLowerCase(), async () => {
      const base = `${gh.rawUrl}/${d.owner}/${d.repo}/${encodeURIComponent(tag).replace(/%2F/g, '/')}`;
      const [appJsonText, appLua, readme] = await Promise.all([
        get(`${base}/app.json`, { raw: true, optional: true }),
        get(`${base}/app.lua`, { raw: true, optional: true }),
        get(`${base}/README.md`, { raw: true, optional: true }),
      ]);
      if (appJsonText === null || appLua === null) {
        throw new HttpError(422, `Versionen ${tag} av ${d.id} saknar app.json eller app.lua i roten och kan inte installeras`);
      }
      let appJson;
      try {
        appJson = JSON.parse(appJsonText);
      } catch {
        throw new HttpError(422, `app.json i ${d.id} ${tag} är inte giltig JSON`);
      }
      if (!appJson || typeof appJson !== 'object' || Array.isArray(appJson)) throw new HttpError(422, `app.json i ${d.id} ${tag} är inte ett JSON-objekt`);
      const name = typeof appJson.name === 'string' && appJson.name.trim() ? appJson.name.trim().slice(0, 100) : d.name;
      return {
        id: d.id,
        tag,
        version: v.name,
        appJson: appJsonText,
        appLua,
        meta: {
          name,
          short_description: (d.description || name).slice(0, 250),
          description: (readme || d.description || '').slice(0, MAX_README),
          tags: d.topics.slice(0, 20),
          category: typeof appJson.category === 'string' && appJson.category ? appJson.category : 'other',
          source_url: d.url,
        },
      };
    });
  }

  return { catalog, details, package: pkg, trusted };
}
