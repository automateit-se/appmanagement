# Releases

Release notes, one file per version, ready to paste into a GitHub release.

To publish version `x.y.z`:

1. Check that the latest *container* run on `main` is green (Actions).
2. On GitHub: *Releases → Draft a new release*.
   - *Choose a tag*: type `vx.y.z` and pick *Create new tag on publish* (target `main`).
   - *Release title*: `vx.y.z`.
   - *Description*: the contents of `docs/releases/vx.y.z.md`.
3. *Publish release*. The tag starts the *container* workflow, which publishes `ghcr.io/automateit-se/appmanagement:x.y.z`, `:x.y` and `:latest` and shows the version at the bottom of the page.
4. On the server: `sudo appmanagement-update` (see *Updating* in the README), or by hand `APPMANAGEMENT_TAG=x.y.z` in `/opt/appmanagement/.env`, then `sudo docker compose pull && sudo docker compose up -d`.
