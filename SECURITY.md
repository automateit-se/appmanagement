# Security

This document describes the security model of App Management and what an operator must take care of when deploying it.

## Model

App Management has **no database and no accounts of its own**. Every IoT Open request is made as the signed-in IoT Open user, with that user's token, and **IoT Open decides** what the user may read and change. The backend adds two things IoT Open does not cover:

1. **Reading public edge apps from GitHub.** Only public data is read. What is installed is chosen by the user.
2. **Running an IoT Open Docker Edge Client in the local Docker environment.** This is the sensitive part: access to the Docker API is, in practice, root access to the Docker host.

## What is in place

| Area | Measure |
|---|---|
| IoT Open relay (SSRF) | `/api/v2/…` is relayed only to one fixed `LYNX_URL`, validated at start (https, no path, query or credentials, host in `ALLOWED_LYNX_HOSTS`). Nothing in a request can change the target. Everything else under `/api/` answers 404, and with `API_MODE=direct` nothing is relayed |
| Upstream TLS | Node verifies IoT Open's and GitHub's certificates |
| Brute force | `/api/v2/auth` is limited to 10 requests per minute per client address (`REAL_IP_HEADER` behind a proxy) |
| Forwarding headers | Only `X-API-Key`, `Authorization`, `Content-Type`, `Accept` and `Accept-Language` are passed on to IoT Open. Cookies are never passed in either direction |
| Edge client access | Every edge client call checks the token with IoT Open (`/user/me`, cached for one minute) and that the user can see the installation (`/installationinfo`). `EDGE_ADMINS` restricts it further to named users |
| Docker scope | The backend only lists and changes containers labelled `se.automateit.appmanagement.role=edge-client` for the installation and IoT Open host in question, and volumes named `iotopen-edge-<installation>-config`. Container settings are fixed in the code (image from `EDGE_CLIENT_IMAGE`, no ports, no privileges, no host mounts, 256 MB memory). Nothing from a request ends up in the container definition except the installation id (a number) |
| Credentials | Gateway credentials are created by the backend as the signed-in user and written into the edge client's volume as `iotopen.json` (root, mode 0600). They are never sent to the browser, logged or put in environment variables (where `docker inspect` would show them) |
| Destructive actions | Creating or renewing credentials, which disconnects any other edge client of the installation, requires an explicit confirmation in the request. Creating them is refused (409) while IoT Open reports an edge client of the installation as online, unless the request explicitly says it replaces it. One operation per installation runs at a time |
| Edge status | Read with the signed-in user's own token: the backend subscribes to `<client_id>/box/event/status` over MQTT (WebSocket to `LYNX_URL/mqtt`) for at most a few seconds and does not publish anything |
| GitHub | Owner, repository and tag are validated; a tag must be one of the repository's releases or tags, and the repository must carry `GITHUB_TOPIC`. Files are limited to 512 KB. `GITHUB_OWNERS` limits the catalogue to trusted owners |
| Browser | CSP (scripts, styles and images only from this origin; connections to this origin, plus `https:` with `CUSTOM_SERVERS=true` or exactly `LYNX_URL` with `API_MODE=direct`), `X-Content-Type-Options`, `Referrer-Policy`, `X-Frame-Options`, `Permissions-Policy`, `Cross-Origin-Opener-Policy`. README files from GitHub are rendered as React elements (escaped), never as HTML, and only `https:` links are kept |
| Container | Non-root (`node`), no runtime dependencies, read-only root file system and no capabilities in the example compose file, health check at `/healthz` |

## Operator checklist

1. **Use the socket proxy.** Give App Management `DOCKER_HOST=tcp://docker-proxy:2375` with [docker-socket-proxy](https://github.com/Tecnativa/docker-socket-proxy) on an internal network, as in `docker-compose.yml`, rather than mounting `/var/run/docker.sock` into App Management. The proxy limits the API to containers, images and volumes. It still allows creating containers, so treat App Management as a privileged service: anyone who can take over the App Management container can take over the Docker host.
2. **Leave `DOCKER_HOST` empty if you do not need edge clients.** App Management then has no Docker access at all.
3. **Set `EDGE_ADMINS`.** Without it, every IoT Open user who can see an installation can create, stop and remove its edge client here.
4. **Set `GITHUB_OWNERS`.** An edge app runs on the edge client with access to the installation's MQTT topics. Without `GITHUB_OWNERS` any public repository with the topic is listed (the user sees a warning). With it, only your own or trusted owners' apps are offered.
5. **Put TLS in front.** The container speaks plain HTTP on port 8080. Passwords and tokens must only travel over HTTPS, so run it behind a TLS-terminating reverse proxy and add `Strict-Transport-Security` there. In proxy mode that reverse proxy sees credentials in clear text; consider `API_MODE=direct` if a third party runs it.
6. **Least privilege accounts.** Installing apps needs access to the installation; creating apps from GitHub needs publishing rights for the organization's edge apps; creating edge client credentials needs the right to do so on the installation. Use personal accounts so IoT Open's trace log shows who did what.
7. **Tokens in the browser.** The token is stored in `sessionStorage`, or in `localStorage` with *Remember me*. On shared devices, do not tick it and sign out. API keys do not expire and are not revoked by signing out.
8. **Do not deploy the mock.** `mock/server.mjs` has fixed test credentials and is only used by the `demo` compose profile and the tests; it is not part of the image.
9. **Pin and update images.** Deploy a version tag rather than `:latest`, rebuild regularly, and consider pinning `EDGE_CLIENT_IMAGE` and the socket proxy image to a digest.

## Known limitations

- The IoT Open endpoints for edge apps and gateway credentials were taken from IoT Open's own client libraries (`go-lynx`, `@iotopen/node-lynx`). If IoT Open changes them, installation or edge client creation fails with IoT Open's error message; nothing is changed half-way on the Docker side.
- `style-src 'unsafe-inline'` is allowed for React style attributes. Scripts are not affected.
- The catalogue of GitHub apps is public (no sign-in needed) because it only shows public GitHub data; it is rate limited per client address.

## Reporting

Report security issues privately to the project owner rather than in a public issue.
