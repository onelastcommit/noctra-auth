import type { Config } from "../config";
import { html } from "../http";

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
:root { color-scheme: light dark; }
body { font: 16px/1.6 system-ui, sans-serif; max-width: 40rem; margin: 4rem auto; padding: 0 1rem; }
code, pre { font-family: ui-monospace, monospace; background: rgba(127, 127, 127, 0.15); border-radius: 4px; padding: 0.1rem 0.3rem; }
pre { padding: 0.75rem 1rem; overflow-x: auto; }
</style>
</head>
<body>
${body}
</body>
</html>`;
}

export function installedPage(config: Config): Response {
  return html(
    200,
    page(
      "Noctra installed",
      `<h1>${escapeHtml(config.slug)} is installed</h1>
<p>Finish connecting Noctra by running this on the machine that runs it:</p>
<pre>noctra github login</pre>
<p>You can close this tab. Noctra never receives the code in this page's address.</p>`,
    ),
  );
}

export function manifestCallbackPage(): Response {
  return html(
    200,
    page(
      "Finish creating your GitHub App",
      `<h1>Finish creating your GitHub App</h1>
<p>GitHub put a one-time <code>code</code> in this page's address. It can be exchanged for your app's private key within one hour, so treat it like a password.</p>
<p>From your checkout of <code>noctra-auth</code>, run:</p>
<pre>npm run import-app -- &lt;code&gt;</pre>
<p>The script exchanges the code, stores the private key and webhook secret as Worker secrets without printing them, and prints the public values for <code>wrangler.toml</code>.</p>`,
    ),
  );
}

export function homePage(config: Config): Response {
  return html(
    200,
    page(
      "noctra-auth",
      `<h1>noctra-auth</h1>
<p>Token service for the <a href="${escapeHtml(config.webUrl)}/apps/${escapeHtml(config.slug)}">${escapeHtml(config.slug)}</a> GitHub App. It mints short-lived, single-repository tokens for linked Noctra instances.</p>
<p>Source and privacy details: <a href="https://github.com/onelastcommit/noctra-auth">github.com/onelastcommit/noctra-auth</a>.</p>`,
    ),
  );
}
