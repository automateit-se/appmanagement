# App Management

Manage IoT Open **Edge Apps** for your installations from one place. It is built like the [IoT Open Dashboard](https://github.com/automateit-se/iotopen-dashboard) (same sign-in, server choice, look and container model), but its job is administrative: it does not show or control devices, it installs, configures and updates the apps that run on an installation's edge client.

- **Install from GitHub with one click.** An edge app is a GitHub repository with `app.lua` and `app.json`, marked with the topic `iotopen-edge-app` or listed in `GITHUB_INCLUDE` (by default IoT Open's own apps, `IoTOpen/edge-app-*`). The user picks the app and a version and clicks *Install* (*Installera*). App Management uploads the version to IoT Open, publishes it and creates the app there if needed. The user never sees `app.lua` or `app.json`, and nothing has to be typed into IoT Open by hand: name, description and tags come from the repository's `edge-app.json` (IoT Open's own convention) or from the repository itself.
- **Settings as a form.** The app's `app.json` describes its settings; App Management renders them as a form and validates them before saving. All input types in IoT Open's [app.json documentation](https://lynx.iotopen.se/tech/docs/platform/edgeapps/app_json.html) are supported: text (also multiline, with `validator`), number, option, checkbox, toggle, function and device selectors (also with a `value` per selected function), notification output selectors and repeat. The form is generic: what it shows is decided by each app's own `app.json`, and an unknown type can still be edited as JSON.
- **Updates.** When a newer release exists on GitHub (or a newer version in IoT Open), the installed app shows *New version* (*Ny version*) and can be updated with its current settings.
- **Existing apps.** Apps that already exist in IoT Open (official apps, or the organization's own) are listed too and can be installed, configured and updated the same way.
- **IoT Open Docker Edge Client.** No edge client? App Management can start one ([ghcr.io/iotopen/edge-client](https://github.com/IoTOpen/docker-edge-client)) in the same Docker environment it runs in. It creates the installation's credentials through the IoT Open API and writes them straight into the edge client's own volume. The page shows whether it runs, its log with errors highlighted, and lets you stop, start, restart, update or remove it. For each installed app it shows whether it runs, its memory, crashes and its own log.
- **Messages on MQTT.** What apps publish on `obj/…` and `evt/…` can be found, picked and followed (history and live) under *MQTT*, wherever the edge client runs, and kept as an app's log on its card.

> The user interface is in Swedish. UI labels in this document are given in English with the Swedish label in parentheses.

## How it fits together

```
browser ── App Management container ─┬─ /api/v2/*      → IoT Open (LYNX_URL), as the signed-in user
                                     ├─ /app-api/catalog → GitHub (public repositories with the topic)
                                     └─ /app-api/edge    → Docker (via docker-socket-proxy) → iotopen-edge-<installation>
```

- **IoT Open is the master.** Users, permissions, apps, versions and installed apps live in IoT Open. App Management has no database and no accounts of its own; every IoT Open call is made with the signed-in user's token (password + two-factor, or an API key, exactly like the dashboard).
- **The backend** is a small Node server without dependencies. It serves the app, relays `/api/v2` to one fixed IoT Open address (`API_MODE=proxy`, the default), reads public data from GitHub and talks to Docker for the edge client.
- **Edge apps on GitHub** are read through the backend so that GitHub's rate limit is shared and cached (5 minutes for lists, 1 hour per version).
- **Edge clients** are managed only when `DOCKER_HOST` is set. The backend only touches containers and volumes it created itself (recognised by labels) and only for installations the signed-in user can see in IoT Open.

## Getting started

```bash
# Production: App Management + a Docker socket proxy for the edge clients
docker compose up -d                        # http://localhost:8080

# Fully local demo against a mock of IoT Open, GitHub and Docker
docker compose --profile demo up --build   # http://localhost:8081  demo@example.com / demo

# Development
npm install
npm run dev:mock                            # mock IoT Open + GitHub + Docker on :8787
LYNX_URL=http://localhost:8787 ALLOWED_LYNX_HOSTS=localhost ALLOW_INSECURE_LYNX_URL=true \
  GITHUB_API_URL=http://localhost:8787/github-api GITHUB_RAW_URL=http://localhost:8787/github-raw GITHUB_INCLUDE='example-vendor/edge-app-*' \
  DOCKER_HOST=tcp://localhost:8787/docker npm run dev:server   # backend on :8080
npm run dev                                 # Vite on :5173, proxies /api, /app-api and /config.json to :8080
npm test                                    # unit tests + the backend against the mock
```

The mock (`mock/server.mjs`, no dependencies) implements the parts of IoT Open, GitHub and the Docker Engine API that App Management uses. Test logins: `demo@example.com` / `demo`, API key `demo-api-key`, and `twofa@example.com` / `demo` with code `123456`. Its GitHub has three made-up apps under `example-org`, one of them deliberately broken.

### Container image

Releases and how to publish one: [docs/releases](docs/releases/README.md).

`.github/workflows/container.yml` runs the tests and builds the image for amd64 and arm64 to GitHub Container Registry:

- a push to `main` gives `ghcr.io/<owner>/<repo>:main` and `:sha-<short>`
- the tag `v1.2.3` gives `:1.2.3`, `:1.2` and `:latest`
- pull requests are tested and built but not published

### Environment variables

| Variable                  | Default                               | Meaning |
|---------------------------|---------------------------------------|---------|
| `LYNX_URL`                | `https://lynx.iotopen.se`             | IoT Open instance that `/api/v2` is relayed to and that edge clients are created for |
| `ALLOWED_LYNX_HOSTS`      | `lynx.iotopen.se`                     | Allowed host names for `LYNX_URL`. The container refuses to start otherwise |
| `ALLOW_INSECURE_LYNX_URL` | `false`                               | `true` allows `http://` (only for the local demo) |
| `APP_TITLE`               | `App Management`                      | Name next to the IoT Open logo |
| `API_MODE`                | `proxy`                               | `proxy`: the browser talks to this container, which relays `/api/v2` to `LYNX_URL`. `direct`: the browser talks to `LYNX_URL` itself |
| `CUSTOM_SERVERS`          | `true`                                | Lets users type another IoT Open server on the sign-in page. Edge clients can only be managed on `LYNX_URL` |
| `BASE_PATH`               | *(empty)*                             | Path prefix when a reverse proxy forwards it unchanged, e.g. `/appmanagement` |
| `GITHUB_TOPIC`            | `iotopen-edge-app`                    | Topic that marks a GitHub repository as an edge app |
| `GITHUB_OWNERS`           | *(empty = all)*                       | Comma separated GitHub users/organizations whose topic-tagged apps are listed. Recommended, see [SECURITY.md](SECURITY.md) |
| `GITHUB_INCLUDE`          | `IoTOpen/edge-app-*`                  | Repositories listed without the topic: `owner/repo` or `owner/prefix-*`, comma separated. `""` = none. These are trusted by the operator, also when `GITHUB_OWNERS` is set |
| `GITHUB_TOKEN`            | *(empty)*                             | Optional token (no scopes needed) for a higher GitHub rate limit |
| `GITHUB_PRERELEASES`      | `false`                               | `true` also offers pre-releases |
| `DOCKER_HOST`             | *(empty = edge clients off)*          | `tcp://docker-proxy:2375` (recommended) or `unix:///var/run/docker.sock` |
| `EDGE_CLIENT_IMAGE`       | `ghcr.io/iotopen/edge-client:latest`  | Image for new edge clients and updates |
| `EDGE_CLIENT_NETWORK`     | *(empty = Docker's default)*          | Docker network for edge client containers, created on first use (bridge, outbound only). `deploy/compose.yml` uses `iotopen-edge` |
| `EDGE_PERMISSION`         | *(empty)*                             | Optional extra restriction on this server: only users whose IoT Open role has this permission may set up new edge clients (start new containers). Looking at, starting, stopping, updating and removing them still follows the role. Give the permission to a dedicated role in IoT Open. Matched as is, as `/all` or `/assigned`, or through a wildcard in the role (`external/example/*`) |
| `EDGE_ADMINS`             | *(empty)*                             | Optional extra restriction on this server: only these IoT Open users may set up new edge clients, on top of their IoT Open role. Comma-separated e-mail addresses, user ids or e-mail domains (`@example.com`) |
| `REAL_IP_HEADER`          | *(empty)*                             | Header with the client address set by a trusted reverse proxy, e.g. `cf-connecting-ip`, for the sign-in rate limit |

### Production behind the edge proxy

[`deploy/compose.yml`](deploy/compose.yml) runs App Management from `ghcr.io` behind [automateit-se/edge](https://github.com/automateit-se/edge) (alias `appmanagement` on the `edge` network, published by `sites/appmanagement.conf` there), with the socket proxy on an internal network. Optional settings go in a `.env` next to it, see [`deploy/env.example`](deploy/env.example).

```bash
sudo mkdir -p /opt/appmanagement && cd /opt/appmanagement
sudo curl -fsSLO https://raw.githubusercontent.com/automateit-se/appmanagement/main/deploy/compose.yml
sudo curl -fsSL -o .env https://raw.githubusercontent.com/automateit-se/appmanagement/main/deploy/env.example
sudo nano .env            # optional settings
sudo docker compose up -d
sudo edge-update          # on the edge host: publishes appmanagement.<domain>
```

Sign-in is IoT Open's own; nothing else is put in front of it.

### Who may do what

IoT Open decides, through the role of the signed-in user (`/api/v2/role/{id}`) and the installations assigned to the user. Change IoT Open's roles and App Management follows; there is nothing to configure on the server.

| Permission in IoT Open (`…/all` or `…/assigned`) | Allows in App Management | Default roles |
|---|---|---|
| `gateway/reset/password` | set up, renew, update, stop, start and remove the installation's edge client | admin (all), owner (assigned) |
| `edge/app/configured/list` | see the edge client's status and log | admin, owner, read_only |
| `edge/app/configured/create_delete` | install and remove apps | admin, owner |
| `edge/app/configured/update` | change settings, update apps | admin, owner |
| `edge/app/create` | create the organization's apps from GitHub | admin, owner |

What the user may not do is not shown. IoT Open checks the same permissions on its own API.

## Making an edge app for App Management

An IoT Open edge app is two files: `app.lua` (the code) and `app.json` (its settings, see IoT Open's [app.json documentation](https://lynx.iotopen.se/tech/docs/platform/edgeapps/app_json.html)). App Management uses the same repository layout as IoT Open's own apps (for example [IoTOpen/edge-app-temperature-notification](https://github.com/IoTOpen/edge-app-temperature-notification)):

```
edge-app-my-app/
├── app.lua
├── app.json
├── edge-app.json    # optional: name, category, short_description, description, tags (IoT Open's convention, also edge_app.json)
└── README.md        # the description when edge-app.json has none
```

1. Add the topic **`iotopen-edge-app`** to the repository (*About → Topics* on GitHub), or list it in `GITHUB_INCLUDE`.
2. Describe the app in `edge-app.json`, or let App Management take it from the repository: name from the repository name (`edge-app-temperature-alarm` → *Temperature alarm*), short description from the repository description, tags from its topics, description from `README.md`. In `edge-app.json`, `publisher`, `public` and `source_url` are ignored: the app is created private to the installation's organization, with the repository as source.
3. Make a **release** (or a tag) for every version, e.g. `v1.0.0`. The version in IoT Open is the tag without the `v` (`1.0.0`). A repository **without releases or tags** can still be installed: the latest commit on its default branch becomes the version `commit-<date>-<sha>`, and a new commit shows up as a new version.

The repository must be public. **Existing apps** work as they are: IoT Open's own repositories are listed through the default `GITHUB_INCLUDE`, and any other repository with `app.lua` and `app.json` only needs the topic. Apps that only exist in IoT Open are listed under *Available in IoT Open* (*Finns i IoT Open*) and work without GitHub. When a GitHub repository is already published in IoT Open by another organization (IoT Open's public apps carry their GitHub repository as `source_url`), App Management installs that published app and its versions instead of creating a copy; the card says *Published in IoT Open by …* (*Publicerad i IoT Open av …*). When a GitHub app only has the same name as an app that already exists in IoT Open (for example IoT Open's own published copy), the app page says so and links to it, so the organization does not get a copy it does not need.

An app in IoT Open can never be deleted, only hidden ([IoT Open: Edge Apps](https://lynx.iotopen.se/tech/docs/platform/edgeapps/)). App Management therefore finds an app it created before by its `source_url` (the repository) and never creates it twice.

### What happens on *Install*

1. The backend reads `app.json`, `app.lua` and `README.md` for the chosen tag from GitHub.
2. The browser looks for the app among the organization's apps in IoT Open by its `source_url` (the GitHub repository). If it is missing, it is created (`POST /api/v2/edge/app`, private to the organization, publisher = the organization's publisher). Name, description and tags are updated when they changed on GitHub.
3. If the version does not exist yet it is uploaded (`POST /api/v2/edge/app/{id}/version`) and published under the tag's name (`POST /api/v2/edge/app/{id}/publish`).
4. The settings form is built from `GET /api/v2/edge/app/{id}/configure?version=…`, and the app is installed on the installation with `POST /api/v2/edge/app/configured/{installation}`.

Updating an installed app runs the same steps for the new version and then `PUT /api/v2/edge/app/configured/{installation}/{id}` with the current settings.

Creating apps requires that the organization is an edge app publisher in IoT Open and that the user may publish for it. Installing apps that already exist only needs access to the installation.

### Logging to MQTT

Apps choose their own topics, and App Management lets the user find and pick them (see [Messages on MQTT](#messages-on-mqtt)). For new apps, this convention makes their log easy to find and read:

- Topic `obj/<app>/<instance id>/log`, for example `obj/doorcounter/1234/log` (`app.id` is the instance id). `obj` is kept in IoT Open's history; use `evt/<app>/<instance id>/<event>` for events that are only of interest when they happen.
- Payload as IoT Open's own messages: `{ "value": <number>, "msg": "<text>", "timestamp": <unix seconds> }`. App Management shows `msg`, else `value`.

```lua
local function logMqtt(text, value)
    mq:pub("obj/doorcounter/" .. app.id .. "/log", json:encode({ value = value or 0, msg = text, timestamp = edge:time() }), false, 0)
end
```

## IoT Open Docker Edge Client

*Edge client → Set up edge client* (*Edge client → Sätt upp edge client*):

1. pulls `EDGE_CLIENT_IMAGE` (a copy the host already has is used if the registry cannot be reached),
2. creates the volume `iotopen-edge-<installation>-config`,
3. creates new gateway credentials in IoT Open (`POST /api/v2/gateway/credentials/{installation}`) as the signed-in user and writes the answer as `/etc/iot-open/iotopen.json` (mode 0600) into that volume. The password never reaches the browser.
4. starts the container `iotopen-edge-<installation>` (`HEADLESS=true`, restart `unless-stopped`, 256 MB memory, log rotation).

IoT Open keeps **one set of credentials per installation**: creating new ones disconnects any other edge client (a Raspberry Pi, a gateway) that uses the old ones. Before it does that, App Management checks the installation's **edge status** in IoT Open (what Lynx shows as *Edge status: Online*):

- Every IoT Open edge client is an MQTT bridge configured with `notification_topic <client_id>/box/event/status`, so it publishes a retained `1` when it connects and `0` when it goes away. The backend subscribes to that topic for a moment as the signed-in user (MQTT over WebSocket, `LYNX_URL/mqtt`) and also asks IoT Open's status API.
- **Online**: the page says clearly that an edge client is online and will be disconnected, the confirmation is worded for that, and the backend refuses (409) unless the request says so explicitly (`replaceOnline`).
- **Offline**: a warning that the installation has had an edge client that will not be able to reconnect.
- **Unknown**: no edge client has reported; the general warning about credentials is shown.

The edge status is also shown for the edge client App Management runs (*In IoT Open*, *I IoT Open*: online means it really reached IoT Open) and on the installation's app list.

| Action | What it does |
|---|---|
| Stop / Start / Restart (*Stoppa / Starta / Starta om*) | The container |
| Update (*Uppdatera*) | Pulls the image again and recreates the container with the same volume (credentials are kept) |
| New credentials (*Nya credentials*) | New credentials from IoT Open into the volume, then a restart |
| Remove (*Ta bort*) | Removes the container, and optionally the volume with the credentials |

The status shows the container state, start time, restarts, memory use against the container's limit, how many apps run and how many of the last 300 log lines look like errors. The log can be followed live and filtered to errors only.

When the installation's edge client runs somewhere else (a gateway, a Raspberry Pi, another server), the page says so, with its edge status in IoT Open: App Management can only show status, logs and app health for edge clients it runs itself.

### App health

For an installation whose edge client runs here, every installed app shows its health on the app list:

- **Runs** (*Kör*), how long it has run and its memory; **Crashing** (*Kraschar*) with the number of crashes in the last hour and the latest error; **Not running** (*Körs inte*); **Waiting to start** (*Väntar på start*) right after it was installed.
- **Log** (*Logg*): the app's own lines from the edge client's log, its start and load errors and Lua errors in its code.
- **Restart** (*Starta om*): saves the app's instance unchanged in IoT Open, and the edge client restarts it within seconds. Needs the right to change the installation's apps.

IoT Open's edge client runs one process per app and writes the app's log lines with the instance id as prefix (`edge-app-<id>[<pid>]: …`). The backend reads the container's process list (Docker's `top`, which runs `ps` on the host) and its log; nothing is run inside the container. Error lines are recognised by their text, since the edge client logs information and errors the same way.

See [SECURITY.md](SECURITY.md) before giving App Management access to Docker.

## Messages on MQTT

*MQTT* on an installation shows what its apps publish on `obj/…` and `evt/…`, wherever the edge client runs (here, on a gateway or a Raspberry Pi). Everything is read with the signed-in user's own token, so IoT Open decides what the user may see.

- **Topics with messages** (*Topics med meddelanden*): the topics that had messages in the last hour, 6 hours or day, with the number of messages and the latest one, plus the latest value of every obj topic. Pick topics, or write a pattern with `+` (one level) and `#` (the rest), for example `obj/doorcounter/#`.
- **Messages** (*Meddelanden*): earlier messages from IoT Open's history (`GET /api/v3beta/log/{installation}`, up to 7 days) and new ones live, with a filter. A message shows its `msg`, else its `value`; a click shows all of it. IoT Open returns at most 10 000 messages per request, and filters on exact topics only, so with wildcards on a busy installation the oldest messages of a long period can be missing (the page says so).
- **Keep as an app's log** (*Spara som logg för*): the picked topics are kept for an app in this browser, and the app's card gets *MQTT log* (*MQTT-logg*).

Live messages come from an MQTT subscription (WebSocket to `LYNX_URL/mqtt`) that the backend holds for the open page and sends on as server-sent events: at most 50 messages per second, for 15 minutes at a time. Only `obj/` and `evt/` can be read, at most 10 patterns at a time. It needs App Management's own IoT Open server (not another server picked at sign-in).
