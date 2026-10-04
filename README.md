# noctra-auth

Token service for the [`noctra-agent`](https://github.com/apps/noctra-agent) GitHub App. It lets [Noctra](https://github.com/onelastcommit/noctra) push branches and open pull requests as `noctra-agent[bot]` without the app's private key ever leaving this service.

A Noctra instance links itself once with `noctra github login`. After that it asks this service for a fresh installation token whenever it needs one. Each token is valid for at most an hour, covers exactly one repository, and carries only the permissions the caller asked for.

It runs on Cloudflare Workers with a D1 database. The hosted instance is `https://auth.getnoctra.dev`.

## How it works

```
noctra github login
  ├─ GitHub device flow ──────────────► user access token (held in memory only)
  ├─ generate Ed25519 keypair (private key stays on the machine, mode 0600)
  └─ POST /link {user token, public key} ──► service checks the user with GitHub,
                                             stores user ID + installation IDs + public key,
                                             discards the user token

every git or gh operation
  └─ POST /token {repository, scope}, signed with the private key
        ├─ signature, timestamp and nonce checked (replays refused)
        ├─ per-instance rate limit
        ├─ repository's installation must be one linked to this instance
        ├─ installation token minted for that one repository and scope
        ├─ linked user must currently have write or admin on the repository,
        │  checked live with GitHub; otherwise the token is revoked and refused
        └─ token + expiry returned
```

## What this service stores

| Table | Contents | Lifetime |
|---|---|---|
| `instances` | A random instance ID, the GitHub numeric user ID, the instance's Ed25519 public key, the link time | Until `noctra github logout`, the user revokes the app's authorisation, or an operator deletes it |
| `instance_installations` | Instance ID and GitHub installation ID pairs | Until the instance is unlinked or the app is uninstalled from that account |
| `nonces` | Request nonces already seen, per instance | About five minutes, purged hourly |
| `rate_limits` | Request counts per instance, and per hashed client address for `/link` | One window (a minute or an hour), purged hourly |

That is everything. It does **not** store:

- GitHub user access tokens (used once during `/link`, then dropped)
- installation tokens (returned to the caller and never written down)
- GitHub logins, email addresses, repository names or repository contents
- instance private keys (they never leave the machine running Noctra)

The app's private key and webhook secret exist only as Worker secrets.

### Audit logs

Every link, token request, unlink and webhook writes one JSON line to the Worker's logs (Workers Logs, with `observability` enabled in `wrangler.toml`). A line records the event, outcome, reason, instance ID, GitHub user ID, installation ID, repository, scope, token expiry and Cloudflare ray ID. Lines never contain a token, user token, signature or key. Workers Logs keeps them according to your Cloudflare plan's retention.

## What the service can and cannot do

It **can** mint a token for a repository only when all of these hold:

1. the request is signed by a linked instance's private key, recently, and not replayed;
2. the app is installed on the repository;
3. that installation is linked to the instance;
4. the linked GitHub user has write or admin access to the repository right now.

Tokens are limited to one repository and to one of three scopes:

| Scope | Permissions | Used for |
|---|---|---|
| `write` | Contents, Pull requests, Issues: write; Checks, Commit statuses, Actions, Metadata: read | Noctra opening PRs, labelling, replying to reviews |
| `git` | Contents: write; Metadata: read | Noctra's own `git fetch` and `git push` |
| `read` | Everything above, read-only | The coding agent (Claude Code, Codex and so on) during a run |

It **cannot**:

- change workflow files (the app has no Workflows permission, so pushes touching `.github/workflows/` are rejected by GitHub);
- act on repositories where the app is not installed, or where the linked user lacks write access;
- read or change organisation or account settings;
- revoke tokens it has already issued after an unlink (they expire within an hour).

Anyone who controls this service, or who obtains the app's private key, can act as the app on every repository it is installed on. That is inherent to GitHub Apps, and it is why the key lives only here, why the code is small and public, and why you can run your own copy.

## API

All endpoints return JSON with `Cache-Control: no-store`. Errors look like `{"error": "<code>", "message": "..."}`.

### `GET /config`

Public app details for clients: `app_id`, `client_id`, `slug`, `install_url`, `bot` (`login`, `id`, `email` for the commit identity) and the available `scopes`.

### Signed requests

`/link`, `/token` and `/unlink` carry four headers:

| Header | Value |
|---|---|
| `X-Noctra-Instance` | The instance ID from `/link` (omitted on `/link` itself) |
| `X-Noctra-Timestamp` | Unix time in seconds; must be within 120 seconds of the server |
| `X-Noctra-Nonce` | 16 to 64 characters of `[A-Za-z0-9_-]`, never reused |
| `X-Noctra-Signature` | Base64 Ed25519 signature of the canonical string below |

The canonical string is these lines joined by `\n`:

```
noctra-auth-v1
POST
<path, e.g. /token>
<timestamp>
<nonce>
<instance ID, empty on /link>
<lowercase hex SHA-256 of the exact request body>
```

Public keys are the raw 32-byte Ed25519 key, base64-encoded.

### `POST /link`

Body: `{"github_token": "<user access token from the device flow>", "public_key": "<base64>"}`, signed with the matching private key.

Returns `201` with `instance_id`, `github_user` (`id`, `login`), `installations` (`id`, `account`) and the `/config` details. Fails with `409 no_installations` (and an `install_url`) when the user can see no installation of the app, `409 public_key_in_use`, or `409 too_many_instances`. Rate limited per client address.

### `POST /token`

Body: `{"repository": "owner/name", "scope": "write" | "git" | "read"}`.

Returns `200` with `token`, `expires_at`, `repository`, `scope` and `permissions`. Notable failures: `404 not_installed`, `403 installation_not_linked` (run `noctra github login` again), `403 insufficient_repo_permission`, `403 installation_refused`, `429 rate_limited` with `Retry-After`.

### `POST /unlink`

Body: `{}`. Deletes the instance and its installation links.

### `POST /webhook`

GitHub webhooks, verified with `X-Hub-Signature-256`.

| Event | Effect |
|---|---|
| `installation.deleted` | Unlinks that installation from every instance |
| `installation.created` | Links the new installation to every instance of the user who installed it |
| `github_app_authorization.revoked` | Deletes every instance of that user |
| `installation_repositories` | Logged only; no repository list is stored, and every mint checks GitHub live, so a removed repository is refused immediately |
| anything else | Logged only |

### Pages

`/installed` is the app's post-install redirect: it tells the user to run `noctra github login` and never uses the OAuth code GitHub appends. `/manifest-callback` supports creating your own app from a manifest (below).

## Self-hosting with your own app

You need a Cloudflare account, Node 22.5 or later, and a GitHub account or organisation to own the app.

1. **Fork and install**

   ```bash
   git clone https://github.com/<you>/noctra-auth && cd noctra-auth
   npm ci
   npx wrangler login
   ```

2. **Create the database** and copy the printed `database_id` into `wrangler.toml`:

   ```bash
   npx wrangler d1 create noctra-auth
   npm run migrate:remote
   ```

3. **Choose the hostname.** Edit `routes` in `wrangler.toml` to a hostname on a zone in your Cloudflare account, or delete the `routes` line to use `noctra-auth.<your-subdomain>.workers.dev`.

4. **Create the GitHub App.** Either:

   - by hand, following [`deploy/github-app/README.md`](https://github.com/onelastcommit/noctra/blob/main/deploy/github-app/README.md) in the Noctra repository with your own name and URLs, then store the secrets:

     ```bash
     npx wrangler secret put GITHUB_APP_PRIVATE_KEY < path/to/app.private-key.pem
     npx wrangler secret put GITHUB_WEBHOOK_SECRET < path/to/webhook-secret.txt
     ```

     The key can be the PKCS#1 file GitHub downloads or a PKCS#8 conversion; both work.

   - or from the manifest: deploy once (step 5), then submit [`manifest.json`](https://github.com/onelastcommit/noctra/blob/main/deploy/github-app/manifest.json) with your URLs through GitHub's manifest flow. GitHub redirects to `/manifest-callback?code=...`; within an hour run `npm run import-app -- <code>`, which stores both secrets without printing them and prints the public values.

5. **Set the public values** in `wrangler.toml` `[vars]` (`GITHUB_APP_ID`, `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_SLUG`, `GITHUB_BOT_USER_ID`; the bot ID comes from `gh api "users/<slug>[bot]" --jq .id`) and deploy:

   ```bash
   npm run deploy
   curl https://<your-host>/config
   ```

6. **Point Noctra at it** by setting `NOCTRA_AUTH_URL=https://<your-host>` in Noctra's `.env` before running `noctra github login`.

### Settings

| Variable | Default | Meaning |
|---|---|---|
| `GITHUB_APP_ID`, `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_SLUG`, `GITHUB_BOT_USER_ID` | (required) | Public app identity |
| `GITHUB_APP_PRIVATE_KEY` | (required secret) | App private key, PEM |
| `GITHUB_WEBHOOK_SECRET` | (required secret) | Webhook secret |
| `TOKEN_REQUESTS_PER_MINUTE` | `60` | Per-instance `/token` limit |
| `LINK_REQUESTS_PER_HOUR` | `10` | Per-client-address `/link` limit |
| `MAX_INSTANCES_PER_USER` | `10` | Linked instances allowed per GitHub user |
| `GITHUB_API_URL`, `GITHUB_WEB_URL` | `https://api.github.com`, `https://github.com` | For GitHub Enterprise Server |

### Rotating secrets

- **Private key**: generate a new key on the app's General page, `wrangler secret put GITHUB_APP_PRIVATE_KEY`, then delete the old key in GitHub.
- **Webhook secret**: change it on the app's General page and `wrangler secret put GITHUB_WEBHOOK_SECRET` straight after; deliveries in between fail and can be redelivered from the app's Advanced page.

## Development

```bash
npm test            # vitest against the real migrations on node:sqlite, with a fake GitHub
npm run typecheck
npm run dev         # wrangler dev; put test-only secrets in .dev.vars (gitignored)
```

## Licence

MIT
