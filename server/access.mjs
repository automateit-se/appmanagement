import { createHash } from 'node:crypto';
import { HttpError, ttlCache } from './http.mjs';

// What the signed-in user may do on an installation, decided by IoT Open's own permission system: the user's role
// (GET /api/v2/role/{id}) and whether the installation is assigned to the user (assigned_installations).
// Permissions come as "<name>/all" (every installation the user can see) and "<name>/assigned" (only assigned ones).
//
//   manageEdge   gateway/reset/password            set up, renew, update, stop, start, remove the edge client
//   viewEdge     edge/app/configured/list           see the edge client's status and log (or manageEdge)
//   installApps  edge/app/configured/create_delete  install and remove apps
//   updateApps   edge/app/configured/update         change settings, update to a new version
//   publishApps  edge/app/create                    create the organization's apps from GitHub
//
// IoT Open checks the same permissions on its own API; App Management uses them for what only it does (the
// Docker side of edge clients) and to show only what the user can actually do.
// EDGE_ADMINS, when set, is an extra restriction on top: only those users may manage edge clients.

const key = (token) => createHash('sha256').update(token).digest('hex');

export function accessChecker(cfg, lynx) {
  const roleCache = ttlCache(60_000);

  async function rolePermissions(token, roleId) {
    if (roleId === undefined || roleId === null) return null;
    return roleCache(`${key(token)}|${roleId}`, async () => {
      try {
        const role = await lynx.call(token, `/api/v2/role/${Number(roleId)}`);
        return { name: role?.name || '', permissions: role?.permissions && typeof role.permissions === 'object' ? role.permissions : {} };
      } catch (e) {
        if (e.status === 401) throw e;
        return null; // the role is not readable for this user: permissions unknown
      }
    });
  }

  return async function access(token, iid) {
    const me = await lynx.me(token);
    const inst = await lynx.installation(token, iid);
    const role = await rolePermissions(token, me.role);
    const assigned = (me.assigned_installations || []).map(Number).includes(Number(iid));
    const perms = role?.permissions || {};
    const can = (name) => perms[`${name}/all`] === true || (perms[`${name}/assigned`] === true && assigned);

    const listed = !cfg.edge.admins.length || cfg.edge.admins.includes(String(me.id)) || cfg.edge.admins.includes(String(me.email || '').toLowerCase());
    const known = role !== null;
    const manageEdge = known && can('gateway/reset/password') && listed;
    return {
      me,
      inst,
      known,
      role: role?.name || null,
      assigned,
      manageEdge,
      viewEdge: manageEdge || (known && can('edge/app/configured/list')),
      // unknown permissions: let IoT Open decide when the user tries
      installApps: !known || can('edge/app/configured/create_delete'),
      updateApps: !known || can('edge/app/configured/update'),
      publishApps: !known || perms['edge/app/create'] === true,
      restrictedBy: !listed ? 'EDGE_ADMINS' : null,
    };
  };
}

/** Throws 403 with an explanation when `allowed` is false. */
export function requireAccess(a, allowed, what) {
  if (allowed) return;
  const why = a.restrictedBy === 'EDGE_ADMINS'
    ? 'App Management är inställt på att bara låta vissa användare hantera edge clients (EDGE_ADMINS).'
    : !a.known
      ? 'Dina behörigheter i IoT Open gick inte att läsa.'
      : `Din roll i IoT Open (${a.role || 'okänd'}) ger inte den behörigheten för installationen.`;
  throw new HttpError(403, `Du får inte ${what}. ${why}`);
}
