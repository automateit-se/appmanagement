import { HttpError, ttlCache } from './http.mjs';
import { sortVersionsDesc, versionName } from '../shared/version.js';

// Edge apps on GitHub. A repository is an edge app for App Management when it has app.lua and app.json in the
// root and either
//   - has the topic GITHUB_TOPIC (default "iotopen-edge-app"), or
//   - matches GITHUB_INCLUDE ("owner/repo" or "owner/prefix-*", default "IoTOpen/edge-app-*": IoT Open's own apps).
//
// What IoT Open needs to know about the app comes from the repository, so nothing is typed in by hand:
//   - edge-app.json (or edge_app.json), IoT Open's own convention: name, category, short_description,
//     description, tags. Its publisher, public and source_url are not used (App Management sets them).
//   - otherwise the repository: name (without "edge-app-"), description, topics and README.md.
// Versions: every release (or tag) is a version, "v1.2.0" -> "1.2.0". A repository without releases or tags gets
// one version from the latest commit on its default branch ("commit-20250603-abc1234"), so it still installs.
// Only public data is read; GITHUB_TOKEN only raises GitHub's rate limit.

const NAME = /^[A-Za-z0-9-]{1,39}$/;
const REPO = /^[A-Za-z0-9._-]{1,100}$/;
const TAG = /^[A-Za-z0-9._\/-]{1,100}$/;
const SHA = /^[0-9a-f]{7,40}$/i;
const MAX_FILE = 512 * 1024;
const MAX_README = 20000;
// IoT Open refuses (HTTP 500) an edge app whose description is too long: about 6 kB went through, 10 kB did not
const MAX_DESCRIPTION = 4000;

/**
 * The description IoT Open gets: the text as it is when short enough, else cut at a paragraph before
 * MAX_DESCRIPTION characters, with a link to the whole text on GitHub.
 */
export function appDescription(text, url, max = MAX_DESCRIPTION) {
  const t = String(text || '').trim();
  if (t.length <= max) return t;
  const more = `\n\n…\n\nHela beskrivningen: ${url}`;
  let cut = t.slice(0, max - more.length);
  const para = cut.lastIndexOf('\n\n');
  if (para > cut.length / 2) cut = cut.slice(0, para);
  return cut.trimEnd() + more;
}
const MANIFESTS = ['edge-app.json', 'edge_app.json'];

export const prettyName = (repo) => {
  const s = String(repo)
    .replace(/^edge[-_]?app[-_]/i, '')
    .replace(/[-_]+/g, ' ')
    .trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
};

/** "IoTOpen/edge-app-*" -> { owner, test(repoName) } */
export function parseInclude(entry) {
  const m = /^([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._*-]{1,100})$/.exec(String(entry).trim());
  if (!m) return null;
  const pattern = m[2];
  const re = new RegExp('^' + pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$', 'i');
  return { owner: m[1], pattern, wildcard: pattern.includes('*'), test: (name) => re.test(name), prefix: pattern.split('*')[0] };
}

/** Manifest fields IoT Open's edge app object has, cleaned. Anything else is ignored. */
export function readManifest(text) {
  let m;
  try {
    m = JSON.parse(text);
  } catch {
    return null;
  }
  if (!m || typeof m !== 'object' || Array.isArray(m)) return null;
  const str = (v, n) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : undefined);
  return {
    name: str(m.name, 100),
    category: str(m.category, 50),
    short_description: str(m.short_description, 250),
    description: str(m.description, MAX_README),
    tags: Array.isArray(m.tags) ? m.tags.filter((t) => typeof t === 'string' && t.trim()).map((t) => t.trim().slice(0, 50)).slice(0, 20) : undefined,
  };
}

export function githubClient(cfg) {
  const gh = cfg.github;
  const includes = gh.include.map(parseInclude).filter(Boolean);
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
    if (r.status === 429 || (r.status === 403 && (r.headers.get('x-ratelimit-remaining') === '0' || /rate limit/i.test(await r.clone().text().catch(() => ''))))) {
      throw new HttpError(503, 'GitHub begränsar antalet anrop just nu. Försök igen om en stund, eller ge tjänsten en GITHUB_TOKEN.');
    }
    if (r.status === 403) throw new HttpError(502, 'GitHub nekade anropet (403). Kontrollera att tjänsten når api.github.com.');
    if (r.status === 404) throw new HttpError(404, 'Hittades inte på GitHub');
    if (!r.ok) throw new HttpError(502, `GitHub svarade HTTP ${r.status}`);
    if (!raw) return r.json();
    const len = Number(r.headers.get('content-length') || 0);
    if (len > MAX_FILE) throw new HttpError(422, 'Filen på GitHub är för stor');
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > MAX_FILE) throw new HttpError(422, 'Filen på GitHub är för stor');
    return buf.toString('utf8');
  }

  const included = (owner, repo) => includes.some((i) => i.owner.toLowerCase() === String(owner).toLowerCase() && i.test(repo));
  const ownerTrusted = (owner) => !gh.owners.length || gh.owners.some((o) => o.toLowerCase() === String(owner).toLowerCase());
  /** Listed repositories: included explicitly, or carrying the topic from a trusted owner. */
  const allowed = (r) => !r.archived && (included(r.owner?.login, r.name) || ((r.topics || []).includes(gh.topic) && ownerTrusted(r.owner?.login)));

  const raw = (owner, repo, ref, file) => `${gh.rawUrl}/${owner}/${repo}/${encodeURIComponent(ref).replace(/%2F/g, '/')}/${file}`;

  async function manifest(owner, repo, ref) {
    for (const f of MANIFESTS) {
      const text = await get(raw(owner, repo, ref, f), { raw: true, optional: true });
      if (text !== null) return readManifest(text);
    }
    return null;
  }

  const summary = (r, man) => ({
    id: r.full_name,
    owner: r.owner?.login,
    repo: r.name,
    name: man?.name || prettyName(r.name),
    description: man?.short_description || r.description || '',
    topics: man?.tags || (r.topics || []).filter((t) => t !== gh.topic),
    stars: r.stargazers_count || 0,
    updated: r.pushed_at || r.updated_at || null,
    url: r.html_url,
    license: r.license?.spdx_id && r.license.spdx_id !== 'NOASSERTION' ? r.license.spdx_id : null,
    archived: !!r.archived,
    defaultBranch: r.default_branch || 'main',
  });

  function checkNames(owner, repo) {
    if (!NAME.test(owner) || !REPO.test(repo)) throw new HttpError(400, 'Ogiltigt repositorynamn');
  }

  const listCache = ttlCache(5 * 60_000, 10);
  const detailCache = ttlCache(5 * 60_000, 200);
  const packageCache = ttlCache(60 * 60_000, 200);
  const sameCache = ttlCache(60 * 60_000, 200);

  /** Map with limited concurrency (GitHub does not like bursts). */
  async function mapLimit(list, n, fn) {
    const out = new Array(list.length);
    let i = 0;
    await Promise.all(
      Array.from({ length: Math.min(n, list.length) }, async () => {
        while (i < list.length) {
          const k = i++;
          out[k] = await fn(list[k]);
        }
      }),
    );
    return out;
  }

  async function catalog() {
    return listCache('all', async () => {
      const found = new Map();
      const add = (r) => r && allowed(r) && found.set(r.full_name.toLowerCase(), r);
      const topicQuery = [`topic:${gh.topic}`, 'archived:false', ...gh.owners.map((o) => `user:${o}`)].join(' ');
      const searches = [get(`${gh.apiUrl}/search/repositories?q=${encodeURIComponent(topicQuery)}&sort=updated&per_page=100`)];
      for (const inc of includes) {
        if (inc.wildcard) {
          const q = [`user:${inc.owner}`, 'archived:false', ...(inc.prefix ? [`${inc.prefix} in:name`] : [])].join(' ');
          searches.push(get(`${gh.apiUrl}/search/repositories?q=${encodeURIComponent(q)}&per_page=100`));
        } else {
          searches.push(get(`${gh.apiUrl}/repos/${inc.owner}/${inc.pattern}`, { optional: true }).then((r) => (r ? { items: [r] } : { items: [] })));
        }
      }
      const results = await Promise.all(searches.map((p) => p.catch((e) => ({ error: e, items: [] }))));
      // one source failing (e.g. a missing repository) still lists the others; all failing is an error
      if (results.every((r) => r.error)) throw results[0].error;
      for (const res of results) (res.items || []).forEach(add);
      const repos = [...found.values()];
      const mans = await mapLimit(repos, 6, (r) => manifest(r.owner.login, r.name, r.default_branch || 'main').catch(() => null));
      return repos.map((r, i) => summary(r, mans[i])).sort((a, b) => a.name.localeCompare(b.name, 'sv'));
    });
  }

  async function versions(r) {
    const owner = r.owner.login;
    const rel = await get(`${gh.apiUrl}/repos/${owner}/${r.name}/releases?per_page=50`);
    let list = (rel || [])
      .filter((x) => !x.draft && (gh.prereleases || !x.prerelease) && TAG.test(x.tag_name || '') && !x.tag_name.includes('..'))
      .map((x) => ({ tag: x.tag_name, name: versionName(x.tag_name), published: x.published_at, notes: String(x.body || '').slice(0, 4000), prerelease: !!x.prerelease }));
    if (!list.length) {
      const tags = await get(`${gh.apiUrl}/repos/${owner}/${r.name}/tags?per_page=50`);
      list = (tags || []).filter((t) => TAG.test(t.name || '') && !t.name.includes('..')).map((t) => ({ tag: t.name, name: versionName(t.name), published: null, notes: '', prerelease: false }));
    }
    if (!list.length) {
      // no releases: the latest commit on the default branch is the version
      const c = await get(`${gh.apiUrl}/repos/${owner}/${r.name}/commits/${encodeURIComponent(r.default_branch || 'main')}`);
      const date = String(c?.commit?.committer?.date || c?.commit?.author?.date || '').slice(0, 10).replace(/-/g, '');
      if (c?.sha) {
        list = [{ tag: c.sha, name: `commit-${date || '0'}-${c.sha.slice(0, 7)}`, published: c.commit?.committer?.date || null, notes: String(c.commit?.message || '').slice(0, 1000), prerelease: false, unreleased: true }];
      }
    }
    return sortVersionsDesc(list, (v) => v.name);
  }

  async function details(owner, repo) {
    checkNames(owner, repo);
    return detailCache(`${owner}/${repo}`.toLowerCase(), async () => {
      const r = await get(`${gh.apiUrl}/repos/${owner}/${repo}`);
      if (!allowed(r)) throw new HttpError(404, `Repositoryt är inte en edge app för App Management (topic ${gh.topic} eller GITHUB_INCLUDE)`);
      const vs = await versions(r);
      const ref = vs[0]?.tag || r.default_branch || 'main';
      const [readme, man] = await Promise.all([get(raw(r.owner.login, r.name, ref, 'README.md'), { raw: true, optional: true }), manifest(r.owner.login, r.name, ref).catch(() => null)]);
      return { ...summary(r, man), versions: vs, readme: (readme || man?.description || '').slice(0, MAX_README) };
    });
  }

  /** Everything IoT Open needs for one version: the two files and the app's description. */
  async function pkg(owner, repo, tag) {
    if (!TAG.test(String(tag || '')) || String(tag).includes('..')) throw new HttpError(400, 'Ogiltig version');
    const d = await details(owner, repo);
    const v = d.versions.find((x) => x.tag === tag);
    if (!v) throw new HttpError(404, `Versionen ${tag} finns inte på GitHub`);
    return packageCache(`${d.id}@${tag}`.toLowerCase(), async () => {
      const [appJsonText, appLua, readme, man] = await Promise.all([
        get(raw(d.owner, d.repo, tag, 'app.json'), { raw: true, optional: true }),
        get(raw(d.owner, d.repo, tag, 'app.lua'), { raw: true, optional: true }),
        get(raw(d.owner, d.repo, tag, 'README.md'), { raw: true, optional: true }),
        manifest(d.owner, d.repo, tag).catch(() => null),
      ]);
      if (appJsonText === null || appLua === null) {
        throw new HttpError(422, `Versionen ${v.name} av ${d.id} saknar app.json eller app.lua i roten och kan inte installeras`);
      }
      let appJson;
      try {
        appJson = JSON.parse(appJsonText);
      } catch {
        throw new HttpError(422, `app.json i ${d.id} ${v.name} är inte giltig JSON`);
      }
      if (!appJson || typeof appJson !== 'object' || Array.isArray(appJson)) throw new HttpError(422, `app.json i ${d.id} ${v.name} är inte ett JSON-objekt`);
      const name = man?.name || (typeof appJson.name === 'string' && appJson.name.trim() ? appJson.name.trim().slice(0, 100) : d.name);
      return {
        id: d.id,
        tag,
        version: v.name,
        appJson: appJsonText,
        appLua,
        meta: {
          name,
          short_description: (man?.short_description || d.description || name).slice(0, 250),
          description: appDescription(man?.description || readme || d.description || '', d.url),
          tags: man?.tags || d.topics.slice(0, 20),
          category: man?.category || (typeof appJson.category === 'string' && appJson.category ? appJson.category : 'other'),
          source_url: d.url,
        },
      };
    });
  }

  /**
   * Whether the version ``tag`` has the same app.json and app.lua as the commit ``commit`` (a short or full sha).
   * An app installed from a commit (version "commit-20261027-2562ba3") and later released without changing its code
   * gets nothing new from the release: IoT Open keeps the code under the commit's name, so it is no update.
   */
  async function sameCode(owner, repo, tag, commit) {
    if (!SHA.test(String(commit || ''))) throw new HttpError(400, 'Ogiltig commit');
    const p = await pkg(owner, repo, tag);
    const d = await details(owner, repo);
    return sameCache(`${p.id}@${tag}#${commit}`.toLowerCase(), async () => {
      const c = await get(`${gh.apiUrl}/repos/${d.owner}/${d.repo}/commits/${encodeURIComponent(commit)}`, { optional: true });
      if (!c?.sha || !SHA.test(c.sha)) return { same: false };
      const [appJson, appLua] = await Promise.all([
        get(raw(d.owner, d.repo, c.sha, 'app.json'), { raw: true, optional: true }),
        get(raw(d.owner, d.repo, c.sha, 'app.lua'), { raw: true, optional: true }),
      ]);
      return { same: appJson !== null && appLua !== null && appJson === p.appJson && appLua === p.appLua };
    });
  }

  return { catalog, details, package: pkg, sameCode };
}
