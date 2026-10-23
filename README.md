# Zebra storage

Content-addressed file storage for the SmartStock apps. Files are stored as IPFS (Helia) blocks in a folder on disk,
and the file index (names, types, sizes) is appended to a namespaced DAG log **inside the same folder**, so the folder
describes itself and can be moved or backed up as one unit.

It runs as a set of functions on the [bfast-functions](https://github.com/fahamutech/bfast-functions) engine.

## What you get

| URL | What |
|---|---|
| `/` and `/storage` | Landing page |
| `/storage/auth/login` | Sign in to the console |
| `/storage/admin` | Console: store stats, files, access tokens, integrity checks |
| `POST /storage` | Upload (multipart, field `multipleFiles`) |
| `GET /storage/:cid/:filename` | Download a file |
| `POST /storage/admin/tokens` | Mint a write/read token (admin session) |

Everything except the file routes lives under `/storage/...`. The older `POST /shop/:pid/:aid/storage` upload alias is kept for existing apps.

## Run it locally

```bash
npm install
cp .env.example .env   # then set ADMIN_EMAILS to your Google email
npm run dev            # http://localhost:3003
```

## Configuration

Set these as environment variables on the service (or in `.env` for local runs).

| Variable | Required | Default | Notes |
|---|---|---|---|
| `ADMIN_EMAILS` | **yes** | – | Comma-separated Google emails of the owners. They sign in to the console and can add other admins. |
| `FIREBASE_WEB_CONFIG` | no | shared `bfastapp` project | JSON with `projectId`, `apiKey`, `authDomain`, `appId` to use your own Firebase project. |
| `AUTH_SESSION_TTL_SEC` | no | `43200` (12 h) | How long a console sign-in lasts. |
| `AUTH_USERS_JSON` | no | – | Service accounts that exchange a username and password for a token at `/storage/auth/token`. Prefer console-minted tokens. |
| `STORAGE_BLOCKSTORE_DIR` | recommended | `~/zebra-store` | The one folder that holds blocks **and** state (`_meta/`). Point it at persistent storage. |
| `NODE_ENV` | recommended | – | `production` on servers. |
| `AUTH_COOKIE_SECURE` | recommended | `auto` | `true` when served over HTTPS. |
| `STORAGE_REQUIRE_WRITE_TOKEN` | no | `false` | `true` rejects uploads without a valid token. |
| `STORAGE_PUBLIC_READ` | no | `true` | `false` requires a token to read files. |
| `STORAGE_NAMESPACE` | no | `smartstock-storage` | Namespace of the index log. |
| `AUTH_ISSUER`, `AUTH_AUDIENCE`, `AUTH_KEY_ID`, `AUTH_TOKEN_TTL_SEC` | no | see `.env.example` | Session token settings. |

### Signing in

The console uses **Google sign-in** (Firebase Authentication, the same `bfastapp` project as the bfast cloud console).

1. In the Firebase console, open project `bfastapp` > Authentication > Settings > **Authorized domains** and add the domain
   you serve Zebra from (for example `zebra.example.com`). `localhost` is allowed by default. Without this, the Google
   popup fails with `auth/unauthorized-domain` and nobody can sign in.
2. Set `ADMIN_EMAILS` on the service to the owners' Google emails.
3. Open `/storage/auth/login` and choose **Continue with Google**. Only verified Google accounts on the list are let in.
4. In the console, **Team** adds and removes other Google accounts. Removing someone ends their session at once.
   Owners from `ADMIN_EMAILS` can only be changed on the server.

Admins added in the console are stored in `_meta/admins.json`.

### The data folder

```
<STORAGE_BLOCKSTORE_DIR>/
  <shard folders>/…data      file blocks and the index log
  _meta/
    helia-storage-root.cid   pointer to the newest index entry (a cache)
    helia-storage-root.snapshot.json
    keys/                    signing keypair for tokens
    tokens.json              registry of write tokens (for revocation)
    admins.json              admins added in the console
```

Back up or move the whole folder. If `_meta` is lost, **Rebuild index from store** in the console finds the newest index
entry again. If `_meta/keys` is lost, every issued token stops working.

## Deploy

### Option A: bfast cloud (Docker Swarm)

1. **Create the service** in the bfast cloud console: project `zebra`, git mode, clone URL of this repo, replicas `0`.
   Private repo? Add `GIT_USERNAME` and `GIT_TOKEN`. It clones the repo's default branch (`main`).
2. **Create the data folder on the node it will run on, and give it to the container user.** This is the step that is
   easy to miss. The container runs as `node` (uid 1000) and cannot write to a root-owned folder:

   ```bash
   mkdir -p /root/zebra-store
   docker exec <any running bfast container> id        # confirm the uid, normally 1000
   chown -R 1000:1000 /root/zebra-store
   ```

3. **Pin it to that node, mount the folder, set env and start.** The console cannot set mounts or placement, so use the CLI:

   ```bash
   docker service update \
     --constraint-add 'node.hostname==<node-hostname>' \
     --mount-add 'type=volume,source=zebra_store,target=/data/zebra-store,volume-driver=local,volume-opt=type=none,volume-opt=o=bind,volume-opt=device=/root/zebra-store' \
     --update-order stop-first --update-parallelism 1 \
     --label-add bfast.managed=true \
     --env-add STORAGE_BLOCKSTORE_DIR=/data/zebra-store \
     --env-add NODE_ENV=production --env-add AUTH_COOKIE_SECURE=true \
     --env-add ADMIN_EMAILS=you@gmail.com \
     --replicas 1 \
     zebra_faas
   ```

   - `stop-first` makes sure two copies never write to the same folder.
   - `bfast.managed=true` keeps the service visible and editable in the console (a plain bind mount or a manager
     constraint would hide it as infrastructure; this needs a console build that includes the label).
4. **Add a domain** by extending the Traefik router rule, and point the DNS record at the server:

   ```bash
   docker service update --label-add \
     'traefik.http.routers.zebra-faas.rule=Host(`zebra-faas.bfast.example.com`,`zebra.example.com`)' zebra_faas
   ```

5. **Check:** `docker service logs --tail 50 zebra_faas` ends with `Engine Listening on 3000`, and
   `https://<domain>/functions-all` lists the Zebra routes. The container always listens on `PORT=3000`; the Traefik
   service port label must say 3000 too.

### Option B: pm2 on a plain server

```bash
git clone <this repo> && cd smartstock-storage && npm ci --omit=dev
export STORAGE_BLOCKSTORE_DIR=/var/lib/zebra-store ADMIN_EMAILS=you@gmail.com NODE_ENV=production
pm2 start "npx bfast fs serve -p 3003" --name zebra --update-env
```

Make sure the user running pm2 owns `STORAGE_BLOCKSTORE_DIR`. Put a reverse proxy with HTTPS in front.

### Moving existing data to a new server

Stop the old process, copy the whole folder (blocks and `_meta`), start the new one with `STORAGE_BLOCKSTORE_DIR`
pointing at the copy, and run **Verify all files** in the console. Never run two servers on the same folder.

## Tokens: how clients write (and read)

1. Sign in with Google at `/storage/auth/login`, open **Access**, and mint a token per service (write only, or read + write).
   Tokens never expire; revoke them in the same screen.
2. Clients send `Authorization: Bearer <token>`:

   ```bash
   curl -X POST https://zebra.example.com/storage -H "Authorization: Bearer $TOKEN" -F "multipleFiles=@file.png"
   ```

3. **Roll out safely.** Start with the defaults (`STORAGE_REQUIRE_WRITE_TOKEN=false`, `STORAGE_PUBLIC_READ=true`) so
   existing apps keep working. Untokened uploads are logged as `[zebra:untokened-write]`. When the logs go quiet, set
   `STORAGE_REQUIRE_WRITE_TOKEN=true`. To make reads private too, first put the clients in proxy read mode, then set
   `STORAGE_PUBLIC_READ=false`.
4. Client settings in the SmartStock, FitFlex and HomeMate servers: `ZEBRA_TOKEN` (or `STORAGE_TOKEN` for HomeMate) and
   `ZEBRA_READ_MODE=proxy` once reads need a token.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `EACCES: permission denied, mkdir '/data/zebra-store/_meta'` | The mounted folder is not writable by the container user. `chown -R 1000:1000 <host folder>` (check the uid with `docker exec … id`). |
| `invalid mount config … bind source path does not exist` | The host folder is missing on the node the task was scheduled to. Create it there, and pin the service to that node. |
| `HTTP Error: 401 … Repository not found` in the logs | Private repo. Add `GIT_USERNAME` and `GIT_TOKEN`. |
| `/functions-all` shows 0 functions, every route is 404 | `bfast.json` ignores a path that matches the engine's own folders. Keep its `ignore` list to `node_modules` and specs. |
| `service update paused` | The new task failed. Read `docker service ps zebra_faas --no-trunc` and `docker service logs`, fix, then `docker service update --force zebra_faas`. |
| 502 or 504 from the domain | The Traefik service port label and `PORT` must match (3000). |
| Google popup fails with `auth/unauthorized-domain` | Add the domain under Firebase Authentication > Settings > Authorized domains. |
| "… does not have access" after signing in | The Google account is not in `ADMIN_EMAILS` or the Team list. An owner adds it in **Team**. |
| Nobody can get in (no owner set) | `ADMIN_EMAILS` is missing on the service. Set it and redeploy. |
| Files listed but "missing" in Verify | The index points at blocks that are not in the folder (partial copy). Restore the blocks or remove the entries. |

## Security notes

- Keep `_meta/keys` private and backed up. Rotating it (delete the folder, restart) invalidates all issued tokens.
- Do not commit real keys or passwords. Set secrets as service environment variables.
- Console access is by Google account only. Keep `ADMIN_EMAILS` to people you trust, since every admin has full access.
