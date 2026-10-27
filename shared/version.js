// Version helpers shared by the backend and the browser.

/** GitHub tag -> IoT Open version name: "v1.2.0" -> "1.2.0", anything else unchanged. */
export const versionName = (tag) => String(tag || '').replace(/^v(?=\d)/i, '');

/** Compares "1.10.0" and "1.9.2" numerically part by part; non-numeric parts compare as text. */
export function compareVersions(a, b) {
  const pa = versionName(a).split(/[.\-+]/);
  const pb = versionName(b).split(/[.\-+]/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i];
    const y = pb[i];
    if (x === undefined) return y !== undefined && /^\d+$/.test(y) ? -1 : 1; // 1.0 < 1.0.1, but 1.0-rc < 1.0
    if (y === undefined) return /^\d+$/.test(x) ? 1 : -1;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny) {
      if (Number(x) !== Number(y)) return Number(x) - Number(y);
    } else if (nx !== ny) {
      return nx ? 1 : -1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

/** A version made from a commit of an app without releases: "commit-20261027-2562ba3". */
export const isCommitVersion = (name) => /^commit-\d{8}-[0-9a-f]{7,40}$/i.test(String(name || ''));

/**
 * Whether ``latest`` should be offered as an update for the installed ``installed``.
 *
 * Release versions compare as versions. A commit version cannot be ordered by its hash, and two commits from the same
 * day share the date: when ``latest`` is the head commit of an app without releases (``headCommit``), any other
 * installed commit is older, since GitHub has nothing newer. A release is always newer than a commit.
 */
export function isNewerVersion(latest, installed, { headCommit = false } = {}) {
  if (!latest) return false;
  if (!installed) return true;
  if (isCommitVersion(latest) && isCommitVersion(installed)) {
    if (versionName(latest) === versionName(installed)) return false;
    const day = (v) => Number(String(v).split('-')[1]);
    if (day(latest) !== day(installed)) return day(latest) > day(installed);
    return headCommit;
  }
  if (isCommitVersion(installed)) return true; // the app has releases now
  if (isCommitVersion(latest)) return false;
  return compareVersions(latest, installed) > 0;
}

/** Newest first. */
export const sortVersionsDesc = (list, key = (v) => v) => [...list].sort((a, b) => compareVersions(key(b), key(a)));
