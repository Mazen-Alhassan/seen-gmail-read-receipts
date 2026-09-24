// One-command setup: creates the database, deploys the server to your Cloudflare account,
// and builds the extension pointed at it. Safe to re-run (it reuses what already exists).
//
//   pnpm run deploy-server                              → https://seen.<you>.workers.dev
//   pnpm run deploy-server -- --domain seen.example.com  → your own domain (recommended; see docs/SETUP.md)
//   pnpm run deploy-server -- --new-invite               → rotate the invite code
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";

const root = path.join(import.meta.dirname, "..");
const serverDir = path.join(root, "server");
const extDir = path.join(root, "extension");
const wranglerConfig = path.join(serverDir, "wrangler.jsonc");
const inviteFile = path.join(serverDir, ".seen-invite");
const extEnv = path.join(extDir, ".env");

const args = process.argv.slice(2);
const domain = valueOf("--domain");
const newInvite = args.includes("--new-invite");

function valueOf(flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
let n = 0;
const step = (s) => console.log(`\n${bold(`${++n}. ${s}`)}`);

function wrangler(argv, { env, quiet } = {}) {
  const res = spawnSync("npx", ["wrangler", ...argv], {
    cwd: serverDir,
    encoding: "utf8",
    env: { ...process.env, ...env },
    stdio: quiet ? ["ignore", "pipe", "pipe"] : ["inherit", "pipe", "inherit"],
  });
  if (res.status !== 0) {
    if (quiet) process.stderr.write(res.stderr ?? "");
    throw new Error(`wrangler ${argv.join(" ")} failed`);
  }
  return res.stdout;
}

/**
 * Run wrangler attached to your terminal, so any question it asks (e.g. "register a workers.dev
 * subdomain?" on a new Cloudflare account) reaches you — wrangler only asks when both stdin and
 * stdout are a real terminal. Its output is read back from its log file instead.
 */
function wranglerInteractive(argv) {
  const log = path.join(os.tmpdir(), `seen-wrangler-${process.pid}.log`);
  rmSync(log, { force: true });
  return new Promise((resolve, reject) => {
    const child = spawn("npx", ["wrangler", ...argv], {
      cwd: serverDir,
      stdio: "inherit",
      env: { ...process.env, WRANGLER_LOG_PATH: log },
    });
    child.on("close", (code) => {
      const out = existsSync(log) ? readFileSync(log, "utf8") : "";
      rmSync(log, { force: true });
      code === 0 ? resolve(out) : reject(new Error(`wrangler ${argv[0]} failed (see the messages above)`));
    });
  });
}

async function main() {
  console.log(bold("Seen — server setup"));

  step("Cloudflare account");
  const who = spawnSync("npx", ["wrangler", "whoami"], { cwd: serverDir, encoding: "utf8" });
  if (who.status !== 0 || /not authenticated/i.test(`${who.stdout}${who.stderr}`)) {
    console.log("Opening your browser to log in to Cloudflare (free account is fine)…");
    const login = spawnSync("npx", ["wrangler", "login"], { cwd: serverDir, stdio: "inherit" });
    if (login.status !== 0) throw new Error("Cloudflare login failed");
  } else {
    console.log(dim("Already logged in."));
  }

  step("Database");
  const findDb = () => JSON.parse(wrangler(["d1", "list", "--json"], { quiet: true })).find((d) => d.name === "seen");
  let db = findDb();
  if (!db) {
    wrangler(["d1", "create", "seen"], { quiet: true });
    db = findDb();
  }
  if (!db?.uuid) throw new Error("Couldn't create or find the D1 database 'seen'");
  const config = readFileSync(wranglerConfig, "utf8");
  writeFileSync(wranglerConfig, config.replace(/"database_id":\s*"[^"]*"/, `"database_id": "${db.uuid}"`));
  console.log(dim(`Using D1 database seen (${db.uuid})`));
  wrangler(["d1", "migrations", "apply", "DB", "--remote"], { env: { CI: "true" } });
  // Never deploy code ahead of its database: confirm nothing is left unapplied.
  const pending = wrangler(["d1", "migrations", "list", "DB", "--remote"], { quiet: true, env: { CI: "true" } });
  if (/\d{4}_[\w-]+\.sql/.test(pending) && !/No migrations to apply/i.test(pending)) {
    throw new Error("Database migrations didn't apply — not deploying. Re-run to try again.");
  }

  step("Invite code");
  let invite = !newInvite && existsSync(inviteFile) ? readFileSync(inviteFile, "utf8").trim() : "";
  if (!invite) {
    const code = randomBytes(9).toString("base64url").replace(/[-_]/g, "x").toLowerCase();
    invite = `seen-${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8, 12)}`;
    writeFileSync(inviteFile, `${invite}\n`, { mode: 0o600 });
  }
  console.log(dim("Only extensions that know this code can connect to your server."));

  step("Deploy");
  const secrets = path.join(os.tmpdir(), `seen-secrets-${process.pid}.json`);
  writeFileSync(secrets, JSON.stringify({ INVITE_CODE: invite }), { mode: 0o600 });
  console.log(
    dim("On a new Cloudflare account wrangler asks to register a workers.dev subdomain: answer yes and") +
      "\n" +
      dim("pick any name — your server will live at https://seen.<that-name>.workers.dev"),
  );
  let output;
  try {
    output = await wranglerInteractive(["deploy", "--secrets-file", secrets, ...(domain ? ["--domain", domain] : [])]);
  } finally {
    rmSync(secrets, { force: true });
  }
  const url = domain
    ? `https://${domain}`
    : ([...output.matchAll(/https:\/\/seen\.[a-z0-9-]+\.workers\.dev/gi)].pop()?.[0] ?? null);
  if (!url) throw new Error("Deployed, but couldn't find the server URL in wrangler's output");

  step("Health check");
  let healthy = false;
  // A brand-new workers.dev subdomain can take a few minutes to appear in DNS.
  for (let i = 0; i < 60 && !healthy; i++) {
    if (i === 5) console.log(dim("Waiting for DNS (new subdomains can take a few minutes)…"));
    try {
      healthy = (await (await fetch(`${url}/health`)).json()).ok === true;
    } catch {
      /* DNS for a new subdomain can take a few seconds */
    }
    if (!healthy) await new Promise((r) => setTimeout(r, 3_000));
  }
  console.log(healthy ? dim(`${url} is up.`) : `⚠ ${url} isn't answering yet — DNS may need a few more minutes. Carry on; it'll come up.`);

  step("Extension");
  const env = existsSync(extEnv) ? readFileSync(extEnv, "utf8") : readFileSync(path.join(extDir, ".env.example"), "utf8");
  let appId = /^INBOXSDK_APP_ID=(.*)$/m.exec(env)?.[1]?.trim() ?? "";
  if (!appId && process.stdin.isTTY) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    console.log("Seen uses InboxSDK for Gmail. Get a free app id (takes seconds) at https://register.inboxsdk.com");
    appId = (await rl.question("Paste it here, or press Enter to skip for now: ")).trim();
    rl.close();
  }
  const setVar = (text, key, value) =>
    new RegExp(`^${key}=.*$`, "m").test(text) ? text.replace(new RegExp(`^${key}=.*$`, "m"), `${key}=${value}`) : `${text.trimEnd()}\n${key}=${value}\n`;
  writeFileSync(extEnv, setVar(setVar(env, "SEEN_SERVER_URL", url), "INBOXSDK_APP_ID", appId));
  const build = spawnSync("node", ["build.mjs"], { cwd: extDir, stdio: "inherit" });
  if (build.status !== 0) throw new Error("Extension build failed");

  console.log(`
${bold("Done.")}

  Server       ${url}
  Invite code  ${bold(invite)}   ${dim("(saved in server/.seen-invite)")}

Next:
  1. Open chrome://extensions, turn on Developer mode, click "Load unpacked"
     and choose ${path.relative(process.cwd(), path.join(extDir, "dist")) || "extension/dist"}
  2. Seen's settings page opens. The server address is pre-filled; paste the invite code, Connect.
  3. Reload Gmail and send an email. The ✓ turns into a green ✓✓ when it's opened.
${appId ? "" : `\n  ${bold("Note:")} without an InboxSDK app id Gmail shows a small developer warning bar.\n  Add INBOXSDK_APP_ID to extension/.env and run \`pnpm build\` to remove it.\n`}${domain ? "" : `\n  ${dim("Tip: a custom domain (--domain seen.yourdomain.com) avoids *.workers.dev, which some")}\n  ${dim("privacy filters block. See docs/SETUP.md.")}\n`}`);
}

main().catch((err) => {
  console.error(`\n✘ ${err.message}`);
  process.exit(1);
});
