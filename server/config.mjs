// Settings from environment variables, validated once at start. The container refuses to start on a
// value that could point the proxy or the backend somewhere unintended.

export class ConfigError extends Error {}

const bool = (v, def) => {
  if (v === undefined || v === '') return def;
  if (v === 'true') return true;
  if (v === 'false') return false;
  throw new ConfigError(`expected true or false, got '${v}'`);
};
const list = (v) =>
  String(v || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

/** https://host[:port] without path, query, credentials or trailing slash (http only when allowed). */
export function checkOrigin(name, value, { insecure = false, allowedHosts = null, allowPath = false } = {}) {
  const text = String(value || '').trim();
  if (!text) throw new ConfigError(`${name} is not set`);
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new ConfigError(`${name}='${text}' is not a URL`);
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && insecure)) {
    throw new ConfigError(`${name}='${text}' must use https://`);
  }
  if (url.username || url.password || url.search || url.hash || (!allowPath && url.pathname && url.pathname !== '/') || text.endsWith('/')) {
    throw new ConfigError(`${name}='${text}': only scheme://host[:port] is allowed, without path, trailing slash, query or credentials`);
  }
  if (allowedHosts && !allowedHosts.map((h) => h.toLowerCase()).includes(url.hostname.toLowerCase())) {
    throw new ConfigError(`${name}: host '${url.hostname}' is not in ALLOWED_LYNX_HOSTS (${allowedHosts.join(',')})`);
  }
  return allowPath ? url.origin + url.pathname.replace(/\/$/, '') : url.origin;
}

/** DOCKER_HOST: unix:///path, tcp://host:port or http://host:port. Empty = edge client management off. */
export function parseDockerHost(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  if (text.startsWith('unix://')) return { socketPath: text.slice('unix://'.length) };
  const m = /^(?:tcp|http):\/\/([A-Za-z0-9.-]+):(\d{1,5})(\/[A-Za-z0-9._/-]*)?$/.exec(text);
  if (!m) throw new ConfigError(`DOCKER_HOST='${text}' rejected: use unix:///var/run/docker.sock or tcp://host:port`);
  return { host: m[1], port: Number(m[2]), prefix: (m[3] || '').replace(/\/$/, '') };
}

export function loadConfig(env = process.env) {
  const insecure = bool(env.ALLOW_INSECURE_LYNX_URL, false);
  const allowedHosts = list(env.ALLOWED_LYNX_HOSTS || 'lynx.iotopen.se');
  const lynxUrl = checkOrigin('LYNX_URL', env.LYNX_URL || 'https://lynx.iotopen.se', { insecure, allowedHosts });

  const basePath = String(env.BASE_PATH || '');
  if (basePath && !/^(\/[A-Za-z0-9._~-]+)+$/.test(basePath)) {
    throw new ConfigError(`BASE_PATH='${basePath}' rejected: use "" or e.g. "/appmanagement" (no trailing slash)`);
  }
  const apiMode = env.API_MODE || 'proxy';
  if (!['proxy', 'direct'].includes(apiMode)) throw new ConfigError(`API_MODE='${apiMode}' rejected: use proxy or direct`);

  const appTitle = String(env.APP_TITLE || 'App Management');
  if (/[<>"'\\$]/.test(appTitle)) throw new ConfigError('APP_TITLE rejected: no quotes, backslashes, $, < or >');

  const topic = String(env.GITHUB_TOPIC || 'iotopen-edge-app').toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,49}$/.test(topic)) throw new ConfigError(`GITHUB_TOPIC='${topic}' is not a valid GitHub topic`);
  const owners = list(env.GITHUB_OWNERS);
  for (const o of owners) if (!/^[A-Za-z0-9-]{1,39}$/.test(o)) throw new ConfigError(`GITHUB_OWNERS: '${o}' is not a GitHub user or organization`);
  // repositories listed without the topic: "owner/repo" or "owner/prefix-*". Default: IoT Open's own edge apps. "" = none
  const include = env.GITHUB_INCLUDE === undefined ? ['IoTOpen/edge-app-*'] : list(env.GITHUB_INCLUDE);
  for (const i of include) if (!/^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]*\*?[A-Za-z0-9._-]*$/.test(i)) throw new ConfigError(`GITHUB_INCLUDE: '${i}' is not owner/repo or owner/prefix-*`);

  const edgeImage = String(env.EDGE_CLIENT_IMAGE || 'ghcr.io/iotopen/edge-client:latest');
  if (!/^[a-z0-9]+([._/:@-][a-z0-9]+)*$/i.test(edgeImage)) throw new ConfigError(`EDGE_CLIENT_IMAGE='${edgeImage}' is not an image reference`);
  const edgeNetwork = String(env.EDGE_CLIENT_NETWORK || '');
  if (edgeNetwork && !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(edgeNetwork)) throw new ConfigError(`EDGE_CLIENT_NETWORK='${edgeNetwork}' is not a network name`);

  const realIpHeader = String(env.REAL_IP_HEADER || '').toLowerCase();
  if (realIpHeader && !/^[a-z0-9-]+$/.test(realIpHeader)) throw new ConfigError(`REAL_IP_HEADER='${realIpHeader}' is not a header name`);

  return {
    port: Number(env.PORT || 8080),
    lynxUrl,
    basePath,
    apiMode,
    appTitle,
    customServers: bool(env.CUSTOM_SERVERS, true),
    staticDir: env.STATIC_DIR || new URL('../dist/', import.meta.url).pathname,
    realIpHeader,
    github: {
      topic,
      owners,
      include,
      token: String(env.GITHUB_TOKEN || ''),
      apiUrl: checkOrigin('GITHUB_API_URL', env.GITHUB_API_URL || 'https://api.github.com', { insecure, allowPath: true }),
      rawUrl: checkOrigin('GITHUB_RAW_URL', env.GITHUB_RAW_URL || 'https://raw.githubusercontent.com', { insecure, allowPath: true }),
      prereleases: bool(env.GITHUB_PRERELEASES, false),
    },
    edge: {
      docker: parseDockerHost(env.DOCKER_HOST),
      image: edgeImage,
      network: edgeNetwork,
      // e-mail, user id or a whole e-mail domain ("@example.com" or "*@example.com")
      // an extra IoT Open role permission needed to manage edge clients on this server (none when empty)
      permission: (env.EDGE_PERMISSION || '').trim(),
      admins: list(env.EDGE_ADMINS).map((s) => s.toLowerCase().replace(/^\*@/, '@')),
    },
  };
}
