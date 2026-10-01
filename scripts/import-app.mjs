import { spawnSync } from "node:child_process";

const code = process.argv[2];
if (!code || !/^[A-Za-z0-9_-]{8,}$/.test(code)) {
  console.error("Usage: npm run import-app -- <code from the manifest-callback address bar>");
  process.exit(1);
}

const api = (process.env.GITHUB_API_URL || "https://api.github.com").replace(/\/+$/, "");
const headers = { Accept: "application/vnd.github+json", "User-Agent": "noctra-auth-import" };

const res = await fetch(`${api}/app-manifests/${code}/conversions`, { method: "POST", headers });
if (!res.ok) {
  console.error(`GitHub refused the code (HTTP ${res.status}). Codes expire after one hour and work once.`);
  process.exit(1);
}
const app = await res.json();

function putSecret(name, value) {
  const result = spawnSync("npx", ["wrangler", "secret", "put", name], {
    input: value,
    stdio: ["pipe", "inherit", "inherit"],
  });
  if (result.status !== 0) {
    console.error(`Storing ${name} failed. Re-run with a fresh code after fixing wrangler login.`);
    process.exit(1);
  }
}

putSecret("GITHUB_APP_PRIVATE_KEY", app.pem);
putSecret("GITHUB_WEBHOOK_SECRET", app.webhook_secret);

const bot = await fetch(`${api}/users/${encodeURIComponent(`${app.slug}[bot]`)}`, { headers });
const botId = bot.ok ? (await bot.json()).id : "LOOK_UP_WITH_gh_api_users/<slug>[bot]";

console.log(`
Private key and webhook secret stored as Worker secrets. Put these public values in wrangler.toml [vars]:

GITHUB_APP_ID = "${app.id}"
GITHUB_APP_CLIENT_ID = "${app.client_id}"
GITHUB_APP_SLUG = "${app.slug}"
GITHUB_BOT_USER_ID = "${botId}"

GitHub also generated a client secret, which this service never uses. Delete it on the app's General page.
Then tick "Enable Device Flow" on the same page, because manifests cannot set it.`);
