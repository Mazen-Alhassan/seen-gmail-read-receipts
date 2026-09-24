import type { Client } from "../../shared/api";

/**
 * Who fetched the pixel.
 *  - google_proxy:   Gmail (web or app) opening the email through Google's image proxy
 *  - gmail_prefetch: Gmail loading images on delivery, before anyone opens it
 *  - yahoo_proxy:    Yahoo/AOL Mail's image proxy
 *  - outlook_proxy:  Microsoft's network: Outlook.com / new Outlook loading images for a reader,
 *                    or Microsoft 365's Defender scanning (classify() tells them apart)
 *  - privacy_proxy:  Apple Mail Privacy Protection or Proton — load every email automatically
 *  - scanner:        security gateway / sandbox / other automation
 *  - direct:         a mail app or browser loading the image itself
 *
 * The strongest signal is the user agent of a real mail app (Outlook desktop, Apple Mail,
 * Thunderbird…): scanners and sandboxes use browser-like or tool user agents. A mail app counts
 * as a person whatever network it arrives from — VPNs, corporate web gateways, cloud PCs.
 */
export type Via =
  | "google_proxy"
  | "gmail_prefetch"
  | "yahoo_proxy"
  | "outlook_proxy"
  | "privacy_proxy"
  | "scanner"
  | "direct";

export interface Source {
  via: Via;
  client: Client;
  /** Short human label, e.g. "Gmail", "Outlook on Windows", "Security scanner (Mimecast)". */
  label: string;
  /** A native mail app's user agent (a person reading), as opposed to a browser-like one. */
  mailApp: boolean;
  /** Arrived through a shared network (VPN, corporate gateway, cloud): its IP isn't one person's. */
  relayed: boolean;
  /** Microsoft Defender for Office 365's sandbox signature. */
  defender: boolean;
}

export interface HitFingerprint {
  ua: string | null;
  asn: number | null;
  asOrg: string | null;
}

const ASN_GOOGLE = new Set([15169, 396982, 19527, 36040, 43515]);
const ASN_MICROSOFT = new Set([8075, 8068, 8069]);
const ASN_PROTON = new Set([62371, 209103]);
// Apple, and the partners that run Apple's privacy relays (Cloudflare, Akamai, Fastly).
const ASN_APPLE_RELAY = new Set([714, 6185, 13335, 36183, 20940, 54113]);
// Networks that carry nothing but email security scanning: Proofpoint, Mimecast, Barracuda, IronPort.
const ASN_MAIL_SECURITY = new Set([22843, 26211, 30031, 15324, 16417]);

// Gmail's delivery-time prefetcher: an ancient Edge UA from Google's network.
const GMAIL_PREFETCH_UA = /Chrome\/42\.0\.2311\.135 Safari\/537\.36 Edge\/12\.246/;
// Microsoft Defender's sandbox: frozen Windows Chrome 109.
const DEFENDER_UA = /Windows NT 10\.0; Win64; x64\).*Chrome\/109\.0\.0\.0 Safari\/537\.36$/;

// Email security vendors (their networks scan mail on delivery). Word-bounded so unrelated names
// ("Preset…", "Sagarika", "Dawson", "City and County of San Francisco") never match.
const MAIL_SECURITY_ORG =
  /\b(mimecast|proofpoint|barracuda|ironport|messagelabs|spamtitan|titanhq|hornet ?security|libraesva|appriver|zix|vade|avanan|abnormal security|agari|ironscales|perception point|cloudmark|mailcontrol|spamexperts|mailchannels|mailguard|mailmarshal|cyren|fortimail)\b/i;

// Shared exits people browse through: corporate web gateways and VPNs. Not mail scanners.
const RELAY_ORG =
  /\b(zscaler|netskope|opendns|umbrella|menlo security|iboss|forcepoint|palo alto|m247|datacamp|nordvpn|surfshark|expressvpn|mullvad|private internet access)\b/i;

// Hosting/cloud networks. A browser-like fetch from here is automation.
const DATACENTER_ORG =
  /\b(amazon|aws|google cloud|digitalocean|ovh|hetzner|linode|akamai|vultr|choopa|oracle cloud|alibaba|tencent|leaseweb|scaleway|contabo|hostinger|ionos|equinix metal|cloudflare|fastly|hostwinds|psychz|quadranet|colocrossing)\b|servers\.com/i;

// Word-bounded "bot" so phone names like "CUBOT" don't count.
const BOT_UA =
  /\bbot\b|bot\/|crawler|spider|slurp|curl\/|wget\/|python|go-http-client|java\/|okhttp|axios|node-fetch|undici|libwww|httpclient|headless|phantomjs|puppeteer|playwright|scanner|barracuda|mimecast|proofpoint|messagelabs|ironport|safelinks|linkcheck|urldefense/i;

const MAIL_APP_UA =
  /Microsoft Outlook|MSOffice|ms-office|Outlook-iOS|Outlook-Android|OutlookMobile|Thunderbird|eM Client|Postbox|Airmail|Mailbird|Spark|Canary Mail|SamsungEmail/i;

/** Apple's WebKit without the "Safari/" token: the Mail app (or another iOS mail app). */
function isAppleWebKitMail(ua: string): boolean {
  return /AppleWebKit/i.test(ua) && !/Safari\//i.test(ua) && /(iPhone|iPad|Macintosh)/i.test(ua);
}

export function identify(hit: HitFingerprint): Source {
  const ua = (hit.ua ?? "").trim();
  const org = hit.asOrg ?? "";
  const asn = hit.asn;
  const is = (set: Set<number>) => asn !== null && set.has(asn);
  const base = { mailApp: false, relayed: false, defender: false };

  if (/GoogleImageProxy/i.test(ua)) return { ...base, via: "google_proxy", client: "gmail", label: "Gmail" };
  if (GMAIL_PREFETCH_UA.test(ua)) return { ...base, via: "gmail_prefetch", client: "gmail", label: "Gmail prefetch" };
  if (/YahooMailProxy/i.test(ua)) return { ...base, via: "yahoo_proxy", client: "yahoo", label: "Yahoo Mail" };

  // Apple Mail Privacy Protection: a bare "Mozilla/5.0" from Apple's relays. The same bare UA from
  // anywhere else is just a script.
  if (/^Mozilla\/5\.0$/i.test(ua)) {
    return is(ASN_APPLE_RELAY)
      ? { ...base, via: "privacy_proxy", client: "apple_mail", label: "Apple Mail Privacy Protection" }
      : { ...base, via: "scanner", client: "unknown", label: "Automated fetch" };
  }

  if (!ua) return { ...base, via: "scanner", client: "unknown", label: "Automated fetch (no user agent)" };
  if (BOT_UA.test(ua)) return { ...base, via: "scanner", client: "unknown", label: scannerLabel(ua, org) };

  const relayed =
    RELAY_ORG.test(org) ||
    DATACENTER_ORG.test(org) ||
    is(ASN_MICROSOFT) ||
    is(ASN_GOOGLE) ||
    is(ASN_PROTON) ||
    is(ASN_APPLE_RELAY);

  // A real mail app is someone reading, whatever network it came through.
  if (MAIL_APP_UA.test(ua) || isAppleWebKitMail(ua)) {
    const { client, label } = directClient(ua);
    return {
      via: "direct",
      client,
      label: relayed ? `${label} (via VPN or company network)` : label,
      mailApp: true,
      relayed,
      defender: false,
    };
  }

  if (is(ASN_PROTON) || /\bproton\b/i.test(org)) {
    return { ...base, via: "privacy_proxy", client: "unknown", label: "Proton Mail privacy proxy" };
  }
  if (is(ASN_MAIL_SECURITY) || MAIL_SECURITY_ORG.test(org)) {
    return { ...base, via: "scanner", client: "unknown", label: scannerLabel(ua, org) };
  }
  if (is(ASN_MICROSOFT)) {
    return {
      ...base,
      via: "outlook_proxy",
      client: "outlook",
      label: "Outlook (via Microsoft)",
      relayed: true,
      defender: DEFENDER_UA.test(ua),
    };
  }
  // Google's network but not the image proxy: Google's own automation.
  if (is(ASN_GOOGLE)) return { ...base, via: "scanner", client: "unknown", label: "Automated fetch (Google)" };
  // Browsing through a corporate gateway or VPN: a person, just not from their own IP.
  if (RELAY_ORG.test(org)) {
    const { client, label } = directClient(ua);
    return { ...base, via: "direct", client, label: `${label} (via VPN or company network)`, relayed: true };
  }
  if (DATACENTER_ORG.test(org)) {
    return { ...base, via: "scanner", client: "unknown", label: `Automated fetch (${shortOrg(org)})` };
  }

  const { client, label } = directClient(ua);
  return { ...base, via: "direct", client, label };
}

function directClient(ua: string): { client: Client; label: string } {
  const os = osName(ua);
  const on = os ? ` on ${os}` : "";
  if (/Microsoft Outlook|MSOffice|ms-office|Outlook-iOS|Outlook-Android|OutlookMobile/i.test(ua)) {
    return { client: "outlook", label: `Outlook${on}` };
  }
  if (/Thunderbird/i.test(ua)) return { client: "thunderbird", label: `Thunderbird${on}` };
  if (isAppleWebKitMail(ua)) {
    // On a Mac that's Apple Mail; on iPhone/iPad it could be any iOS mail app except Gmail's.
    return os === "Mac"
      ? { client: "apple_mail", label: "Apple Mail on Mac" }
      : { client: "apple_mail", label: `Mail app${on}` };
  }
  if (MAIL_APP_UA.test(ua)) return { client: "unknown", label: `Mail app${on}` };
  if (/Mozilla\/5\.0/i.test(ua)) return { client: "webmail", label: `Web browser${on}` };
  return { client: "unknown", label: `Mail client${on}` };
}

function osName(ua: string): string | null {
  if (/iPhone/i.test(ua)) return "iPhone";
  if (/iPad/i.test(ua)) return "iPad";
  if (/Android/i.test(ua)) return "Android";
  if (/Windows/i.test(ua)) return "Windows";
  if (/Macintosh|Mac OS X/i.test(ua)) return "Mac";
  if (/CrOS/i.test(ua)) return "ChromeOS";
  if (/Linux/i.test(ua)) return "Linux";
  return null;
}

function scannerLabel(ua: string, org: string): string {
  const vendor = /(mimecast|proofpoint|barracuda|ironport|messagelabs|fortimail|spamtitan|hornet ?security)/i.exec(`${ua} ${org}`)?.[1];
  return vendor ? `Security scanner (${capitalize(vendor)})` : "Automated fetch";
}

function shortOrg(org: string): string {
  return org.replace(/,?\s+(inc|llc|ltd|gmbh|corp|corporation|s\.a\.s?|b\.v)\.?$/i, "").slice(0, 40);
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}
