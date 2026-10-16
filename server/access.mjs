import { createHash } from 'node:crypto';
import { HttpError, ttlCache } from './http.mjs';

// What the signed-in user may do on an installation, decided by IoT Open's own permission system: the user's role
// (GET /api/v2/role/{id}) and whether the installation is assigned to the user (assigned_installations).
// Permissions come as "<name>/all" (every installation the user can see) and "<name>/assigned" (only assigned ones).
//
//   manageEdge   gateway/reset/password            renew, update, stop, start, remove the edge client
//   createEdge   manageEdge + this server's rules   set up a new edge client (a new container on this server)
//   viewEdge     edge/app/configured/list           see the edge client's status and log (or manageEdge)
//   installApps  edge/app/configured/create_delete  install and remove apps
//   updateApps   edge/app/configured/update         change settings, update to a new version
//   publishApps  edge/app/create                    create the organization's apps from GitHub
//
// IoT Open checks the same permissions on its own API; App Management uses them for what only it does (the
// Docker side of edge clients) and to show only what the user can actually do.
// Setting up a new edge client starts a new container on this server, so the server can restrict it further:
// EDGE_PERMISSION, when set, is a role permission that is also needed, and EDGE_ADMINS, when set, names the only
// users who may do it. An entry is a user id,
// an e-mail address or an e-mail domain ("@example.com"), matched against the e-mail IoT Open reports for the user
// (/user/me, also when signed in with an API key: the key belongs to a user).

/** Whether the IoT Open user `me` is allowed by EDGE_ADMINS (everyone when it is empty). */
export function edgeAdmin(admins, me) {
  if (!admins.length) return true;
  const email = String(me?.email || '').trim().toLowerCase();
  const at = email.lastIndexOf('@');
  const domain = at > 0 ? email.slice(at) : null;
  return admins.some((a) => a === String(me?.id) || (email && a === email) || (domain && a === domain));
}

/**
 * Whether a role grants the permission `name`: as is (e.g. external/... permissions), as `<name>/all`, as
 * `<name>/assigned` on an assigned installation, or through a wildcard such as `external/example/*`.
 */
export function hasPermission(perms, name, assigned) {
  if (!name || !perms) return false;
  if (perms[name] === true || perms[`${name}/all`] === true || (assigned && perms[`${name}/assigned`] === true)) return true;
  return Object.entries(perms).some(([k, v]) => v === true && k.endsWith('/*') && name.startsWith(k.slice(0, -1)));
}

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

    const listed = edgeAdmin(cfg.edge.admins, me);
    const known = role !== null;
    const permitted = !cfg.edge.permission || (known && hasPermission(perms, cfg.edge.permission, assigned));
    const manageEdge = known && can('gateway/reset/password');
    return {
      me,
      inst,
      known,
      role: role?.name || null,
      assigned,
      manageEdge,
      createEdge: manageEdge && listed && permitted,
      viewEdge: manageEdge || (known && can('edge/app/configured/list')),
      // unknown permissions: let IoT Open decide when the user tries
      installApps: !known || can('edge/app/configured/create_delete'),
      updateApps: !known || can('edge/app/configured/update'),
      publishApps: !known || perms['edge/app/create'] === true,
      // why this server does not let the user set up a new edge client although the role would (the permission's
      // name is not sent to the browser)
      restrictedBy: !listed ? 'EDGE_ADMINS' : !permitted ? 'EDGE_PERMISSION' : null,
    };
  };
}

/** Throws 403 with an explanation when `allowed` is false. */
export function requireAccess(a, allowed, what) {
  if (allowed) return;
  const why = a.restrictedBy === 'EDGE_ADMINS'
    ? 'På den här servern får bara utvalda användare sätta upp nya edge clients (EDGE_ADMINS).'
    : a.restrictedBy === 'EDGE_PERMISSION'
      ? 'På den här servern krävs en roll i IoT Open med en särskild rättighet för att sätta upp nya edge clients.'
      : !a.known
        ? 'Dina behörigheter i IoT Open gick inte att läsa.'
        : `Din roll i IoT Open (${a.role || 'okänd'}) ger inte den behörigheten för installationen.`;
  throw new HttpError(403, `Du får inte ${what}. ${why}`);
}
