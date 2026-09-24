// Builds the extension into ./dist (load it via chrome://extensions → "Load unpacked").
//   node build.mjs           production build
//   node build.mjs --watch   rebuild on change, with source maps
//   node build.mjs --zip     production build + seen-extension.zip for the Chrome Web Store
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import * as esbuild from "esbuild";

const here = import.meta.dirname;
const dist = path.join(here, "dist");
const args = new Set(process.argv.slice(2));
const watch = args.has("--watch");
const require = createRequire(import.meta.url);

// Config: extension/.env (KEY=value lines) or the environment.
const env = { ...readEnvFile(path.join(here, ".env")), ...process.env };
const appId = env.INBOXSDK_APP_ID?.trim() || "";
const serverUrl = (env.SEEN_SERVER_URL?.trim() || "").replace(/\/+$/, "");
if (!appId) {
  console.warn(
    "\n⚠  INBOXSDK_APP_ID is not set. Seen will work, but Gmail will show an InboxSDK developer\n" +
      "   warning bar. Get a free id at https://register.inboxsdk.com and put it in extension/.env\n",
  );
}

function readEnvFile(file) {
  if (!existsSync(file)) return {};
  const out = {};
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}

const pkg = JSON.parse(readFileSync(path.join(here, "package.json"), "utf8"));

function manifest() {
  return {
    manifest_version: 3,
    name: "Seen — read receipts for Gmail",
    short_name: "Seen",
    version: pkg.version,
    description: "Know when your emails are opened. Quiet check marks in Gmail, open history, and notifications.",
    minimum_chrome_version: "120",
    icons: { 16: "icons/icon16.png", 32: "icons/icon32.png", 48: "icons/icon48.png", 128: "icons/icon128.png" },
    action: {
      default_title: "Seen",
      default_popup: "popup.html",
      default_icon: { 16: "icons/icon16.png", 32: "icons/icon32.png" },
    },
    options_ui: { page: "options.html", open_in_tab: true },
    background: { service_worker: "background.js" },
    // Gmail's mail pages only: not Chat, print view, "Show original" or attachment viewers.
    content_scripts: [
      {
        matches: ["https://mail.google.com/mail/*"],
        exclude_globs: ["*view=pt*", "*view=om*", "*view=att*", "*view=lg*", "*/mail/mu/*"],
        js: ["content.js"],
        run_at: "document_end",
      },
    ],
    // Blocks InboxSDK's own telemetry to its maintainer (usage events, error reports).
    declarative_net_request: { rule_resources: [{ id: "privacy", enabled: true, path: "rules/privacy.json" }] },
    // scripting: InboxSDK injects its page-world helper through the service worker.
    // declarativeNetRequest: blocks your own pixels from loading in your own Gmail.
    permissions: ["storage", "alarms", "notifications", "scripting", "declarativeNetRequest"],
    host_permissions: ["https://mail.google.com/"],
    ...(watch ? { web_accessible_resources: [{ resources: ["*.map"], matches: ["https://mail.google.com/*"] }] } : {}),
  };
}

function copyStatic() {
  cpSync(path.join(here, "static"), dist, { recursive: true });
  // InboxSDK's page-world script must sit at the extension root (it isn't bundled).
  const sdkDir = path.dirname(require.resolve("@inboxsdk/core/package.json"));
  cpSync(path.join(sdkDir, "pageWorld.js"), path.join(dist, "pageWorld.js"));
  writeFileSync(path.join(dist, "manifest.json"), JSON.stringify(manifest(), null, 2));
}

const options = {
  entryPoints: {
    content: "src/content/main.ts",
    background: "src/background/main.ts",
    popup: "src/popup/popup.ts",
    options: "src/options/options.ts",
  },
  absWorkingDir: here,
  outdir: dist,
  bundle: true,
  format: "iife",
  target: "chrome120",
  minify: !watch,
  sourcemap: watch ? "linked" : false,
  legalComments: "none",
  logLevel: "info",
  define: {
    __INBOXSDK_APP_ID__: JSON.stringify(appId || "Seen"),
    __DEFAULT_SERVER_URL__: JSON.stringify(serverUrl),
  },
};

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
copyStatic();

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log("Watching… reload the extension in chrome://extensions after changes.");
} else {
  await esbuild.build(options);
  console.log(`Built ${pkg.name} ${pkg.version} → ${path.relative(process.cwd(), dist) || "dist"}`);
  if (args.has("--zip")) {
    const zip = path.join(here, `seen-extension-${pkg.version}.zip`);
    rmSync(zip, { force: true });
    execFileSync("zip", ["-qr", zip, "."], { cwd: dist });
    console.log(`Packaged → ${path.relative(process.cwd(), zip)}`);
  }
}
