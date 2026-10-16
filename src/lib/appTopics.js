// The MQTT topics a user picked as an app's log, kept in this browser (App Management has no database).
// Per IoT Open server, installation and app instance.

const key = (iid, instanceId) => `am.topics.${location.host}.${Number(iid)}.${Number(instanceId)}`;

export function getAppTopics(iid, instanceId) {
  try {
    const v = JSON.parse(localStorage.getItem(key(iid, instanceId)) || '[]');
    return Array.isArray(v) ? v.filter((t) => typeof t === 'string') : [];
  } catch {
    return [];
  }
}

export function setAppTopics(iid, instanceId, topics) {
  try {
    if (topics?.length) localStorage.setItem(key(iid, instanceId), JSON.stringify(topics));
    else localStorage.removeItem(key(iid, instanceId));
  } catch {
    /* storage unavailable */
  }
}

/** MQTT matching as in the backend: + is one level, # (last) is the rest. */
export function topicMatches(pattern, topic) {
  const p = pattern.split('/');
  const t = topic.split('/');
  for (let i = 0; i < p.length; i++) {
    if (p[i] === '#') return true;
    if (i >= t.length || (p[i] !== '+' && p[i] !== t[i])) return false;
  }
  return p.length === t.length;
}

/** A topic pattern the backend accepts: obj/… or evt/…, + and # only as whole levels, # last. */
export function validPattern(p) {
  const parts = String(p).split('/');
  return (
    p.length <= 200 &&
    ['obj', 'evt'].includes(parts[0]) &&
    parts.length > 1 &&
    parts.every((s, i) => (s === '#' ? i === parts.length - 1 : s === '+' || (s !== '' && !/[#+\s]/.test(s))))
  );
}
