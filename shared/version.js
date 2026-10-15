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

/** Newest first. */
export const sortVersionsDesc = (list, key = (v) => v) => [...list].sort((a, b) => compareVersions(key(b), key(a)));
