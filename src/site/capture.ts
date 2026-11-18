import { chromium, type Browser, type Page } from "playwright-core";
import { existsSync } from "node:fs";

export const CHALLENGE_MARKERS = [
  "Just a moment",
  "Checking your browser",
  "Access denied",
  "Verify you are human",
  "Enable JavaScript and cookies",
  "Vercel Security Checkpoint",
] as const;

const MAX_CHALLENGE_BODY_LENGTH = 1500;

export function isChallengePage(
  title: string,
  bodyText: string,
  html = "",
  responseStatus?: number,
): string | undefined {
  if (responseStatus === 403 || responseStatus === 503) {
    return `HTTP ${responseStatus} response`;
  }

  const titleMarker = CHALLENGE_MARKERS.find((marker) =>
    title.toLowerCase().includes(marker.toLowerCase()),
  );
  if (titleMarker) return titleMarker;

  if (bodyText.length < MAX_CHALLENGE_BODY_LENGTH) {
    const bodyMarker = CHALLENGE_MARKERS.find((marker) =>
      bodyText.toLowerCase().includes(marker.toLowerCase()),
    );
    if (bodyMarker) return bodyMarker;
  }

  if (/id=["']challenge-form["']|cf-chl/i.test(html)) {
    return "Cloudflare challenge markup";
  }

  return undefined;
}

export interface CapturedRequest {
  method: string;
  url: string;
  path: string;
  status: number;
  contentType: string;
  /** Response body (JSON only, truncated). */
  body?: string;
}

export interface Capture {
  url: string;
  title: string;
  description: string;
  lang: string;
  viewport: { width: number; height: number };
  pageHeight: number;
  /** Base64 JPEG slices, top to bottom. Long pages are tiled so no image is taller than ~1800px. */
  screenshotsDesktop: string[];
  screenshotsMobile: string[];
  /** Simplified, cleaned HTML of the body. */
  html: string;
  /** Design tokens read from computed styles. */
  tokens: {
    fonts: string[];
    colors: string[];
    backgrounds: string[];
    radii: string[];
    fontSizes: string[];
    maxWidth: string | null;
    darkMode: boolean;
    cssVars: Record<string, string>;
  };
  /** Semantic outline: landmarks and headings in order. */
  outline: string[];
  links: { text: string; href: string }[];
  images: { alt: string; src: string; w: number; h: number }[];
  requests: CapturedRequest[];
  /** Hints about the original stack (framework fingerprints). */
  fingerprints: string[];
}

export interface CaptureOptions {
  timeoutMs?: number;
  /** Extra time to let SPAs hydrate and lazy content load. */
  settleMs?: number;
  log?: (msg: string) => void;
}

/**
 * Launches a headless browser. Prefers the user's installed Chrome/Edge so
 * nobody has to download 150 MB of Chromium first. Falls back to a Playwright
 * Chromium if present.
 */
async function launch(): Promise<Browser> {
  const attempts: (() => Promise<Browser>)[] = [
    () => chromium.launch({ channel: "chrome", headless: true }),
    () => chromium.launch({ channel: "msedge", headless: true }),
    () => chromium.launch({ channel: "chromium", headless: true }),
    () => chromium.launch({ headless: true }),
  ];
  const envPath = process.env.BREAKINGGOOD_BROWSER;
  if (envPath && existsSync(envPath)) attempts.unshift(() => chromium.launch({ executablePath: envPath, headless: true }));

  let lastErr: unknown;
  for (const a of attempts) {
    try {
      return await a();
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(
    "No Chromium-based browser found. Install Google Chrome or Microsoft Edge, run `npx playwright install chromium`, " +
      "or set BREAKINGGOOD_BROWSER=/path/to/chrome.\n" +
      String((lastErr as Error)?.message ?? "").split("\n")[0],
  );
}

export async function captureSite(url: string, opts: CaptureOptions = {}): Promise<Capture> {
  const log = opts.log ?? (() => {});
  const browser = await launch();
  try {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 1,
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      locale: "en-US",
    });
    const page = await context.newPage();

    const requests: CapturedRequest[] = [];
    const origin = new URL(url).origin;
    page.on("response", async (res) => {
      try {
        const req = res.request();
        const type = req.resourceType();
        if (type !== "xhr" && type !== "fetch") return;
        const ct = res.headers()["content-type"] ?? "";
        const entry: CapturedRequest = {
          method: req.method(),
          url: res.url(),
          path: res.url().startsWith(origin) ? res.url().slice(origin.length) : res.url(),
          status: res.status(),
          contentType: ct.split(";")[0],
        };
        if (/json/.test(ct) && res.status() < 400) {
          const text = await res.text().catch(() => "");
          if (text.length) entry.body = text.slice(0, 6000);
        }
        requests.push(entry);
      } catch {
        /* response body may be gone */
      }
    });

    log("loading page…");
    const navigationResponse = await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: opts.timeoutMs ?? 45_000,
    });
    const challengeTitle = await page.title();
    const challengeBody = await page.locator("body").innerText().catch(() => "");
    const challengeHtml = await page.content().catch(() => "");
    const challengeMarker = isChallengePage(
      challengeTitle,
      challengeBody,
      challengeHtml,
      navigationResponse?.status(),
    );
    if (challengeMarker) {
      throw new Error(
        `Site ${new URL(url).hostname} returned a bot challenge instead of the requested page (matched "${challengeMarker}"). Open the site in a regular browser and resolve the challenge manually before retrying.`,
      );
    }
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
    await dismissCookieBanners(page);
    await autoScroll(page);
    await page.waitForTimeout(opts.settleMs ?? 1200);
    await page.evaluate(() => window.scrollTo(0, 0));

    log("reading DOM, styles and tokens…");
    const extracted = await page.evaluate(extractInPage);
    const rootCssRules = await page.evaluate(() => {
      const rules: { selectorText: string; declarations: [string, string][] }[] = [];
      for (const sheet of Array.from(document.styleSheets)) {
        try {
          for (const rule of Array.from(sheet.cssRules)) {
            if (!("selectorText" in rule)) continue;
            const style = (rule as CSSStyleRule).style;
            const declarations: [string, string][] = [];
            for (let i = 0; i < style.length; i++) {
              const name = style.item(i);
              declarations.push([name, style.getPropertyValue(name)]);
            }
            rules.push({ selectorText: (rule as CSSStyleRule).selectorText, declarations });
          }
        } catch {
          /* cross-origin stylesheets may not expose cssRules */
        }
      }
      return rules;
    });
    extracted.tokens.cssVars = extractRootCssVars(rootCssRules);

    log("screenshots (desktop + mobile)…");
    const screenshotsDesktop = await tiledScreenshots(page, 1440, 1800, 4);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(500);
    const screenshotsMobile = await tiledScreenshots(page, 390, 2400, 3);

    return {
      url,
      viewport: { width: 1440, height: 900 },
      screenshotsDesktop,
      screenshotsMobile,
      requests: dedupeRequests(requests),
      ...extracted,
    };
  } finally {
    await browser.close().catch(() => {});
  }
}

/**
 * Full-page screenshots of long pages blow past model image limits (8000px),
 * so slice the page into tiles from the top. JPEG keeps each under a few hundred KB.
 */
async function tiledScreenshots(page: Page, width: number, tileHeight: number, maxTiles: number): Promise<string[]> {
  const total = await page.evaluate(() => document.documentElement.scrollHeight);
  const out: string[] = [];
  for (let y = 0; y < total && out.length < maxTiles; y += tileHeight) {
    const h = Math.min(tileHeight, total - y);
    if (h < 40) break;
    const buf = await page.screenshot({ fullPage: true, type: "jpeg", quality: 82, clip: { x: 0, y, width, height: h } });
    out.push(buf.toString("base64"));
  }
  return out;
}

async function dismissCookieBanners(page: Page): Promise<void> {
  const labels = ["Accept all", "Accept All", "Accept", "I agree", "Agree", "Got it", "OK", "Allow all", "Accept cookies"];
  for (const l of labels) {
    try {
      const btn = page.getByRole("button", { name: l, exact: false }).first();
      if (await btn.isVisible({ timeout: 300 })) {
        await btn.click({ timeout: 1000 });
        await page.waitForTimeout(300);
        return;
      }
    } catch {
      /* no such button */
    }
  }
}

async function autoScroll(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const step = 700;
    const max = Math.min(document.body.scrollHeight, 12000);
    for (let y = 0; y < max; y += step) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 120));
    }
  });
}

function dedupeRequests(reqs: CapturedRequest[]): CapturedRequest[] {
  const seen = new Set<string>();
  const out: CapturedRequest[] = [];
  for (const r of reqs) {
    const k = r.method + " " + r.url.split("?")[0];
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  return out.slice(0, 40);
}

export function extractRootCssVars(
  rules: { selectorText: string; declarations: [string, string][] }[],
): Record<string, string> {
  const vars: Record<string, string> = {};
  const relevantName = /color|colour|background|brand|primary|secondary|accent|surface|text|radius|size|width|height|spacing|space|gap|padding|margin|font|border/i;

  for (const rule of rules) {
    const targetsRoot = rule.selectorText.split(",").some((selector) => {
      const value = selector.trim();
      return (
        value === ":root" ||
        value.startsWith(":root.") ||
        value.startsWith(":root[") ||
        value === "html" ||
        value.startsWith("html.") ||
        value.startsWith("html[")
      );
    });
    if (!targetsRoot) continue;

    for (const [name, rawValue] of rule.declarations) {
      if (Object.keys(vars).length >= 40) break;
      if (!name.startsWith("--") || !relevantName.test(name)) continue;
      const value = rawValue.trim();
      if (value) vars[name] = value;
    }
    if (Object.keys(vars).length >= 40) break;
  }

  return vars;
}

/** Runs inside the page. Must be self-contained (no imports/closures). */
function extractInPage() {
  const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "SVG", "IFRAME", "LINK", "META", "TEMPLATE"]);
  const KEEP_ATTRS = new Set(["href", "src", "alt", "placeholder", "type", "role", "aria-label", "title"]);

  const fonts = new Map<string, number>();
  const colors = new Map<string, number>();
  const backgrounds = new Map<string, number>();
  const radii = new Map<string, number>();
  const fontSizes = new Map<string, number>();
  const bump = (m: Map<string, number>, k: string, w = 1) => m.set(k, (m.get(k) ?? 0) + w);

  const isTransparent = (c: string) => /rgba\(\s*\d+,\s*\d+,\s*\d+,\s*0\)/.test(c) || c === "transparent";

  const all = Array.from(document.body.querySelectorAll("*")).slice(0, 4000) as HTMLElement[];
  for (const el of all) {
    if (SKIP.has(el.tagName)) continue;
    const cs = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;
    const area = Math.max(1, Math.min(rect.width * rect.height, 500_000)) / 10000;
    const hasText = (el.textContent ?? "").trim().length > 0 && el.children.length === 0;
    if (hasText) {
      bump(fonts, cs.fontFamily.split(",")[0].replace(/["']/g, "").trim());
      bump(colors, cs.color);
      bump(fontSizes, cs.fontSize);
    }
    if (!isTransparent(cs.backgroundColor)) bump(backgrounds, cs.backgroundColor, area);
    if (cs.borderRadius && cs.borderRadius !== "0px") bump(radii, cs.borderRadius.split(" ")[0]);
  }
  const top = (m: Map<string, number>, n: number) =>
    Array.from(m.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, n)
      .map(([k]) => k);

  // Simplified HTML: drop scripts/styles/svg internals, strip classes, cap text.
  const simplify = (node: Element, depth: number): string => {
    if (depth > 14) return "";
    if (SKIP.has(node.tagName)) return node.tagName === "SVG" ? "<svg/>" : "";
    const cs = getComputedStyle(node);
    if (cs.display === "none" || cs.visibility === "hidden") return "";
    const tag = node.tagName.toLowerCase();
    const attrs: string[] = [];
    for (const a of Array.from(node.attributes)) {
      if (!KEEP_ATTRS.has(a.name)) continue;
      let v = a.value;
      if (a.name === "src" && v.startsWith("data:")) v = "data:…";
      if (v.length > 160) v = v.slice(0, 157) + "…";
      attrs.push(`${a.name}="${v.replace(/"/g, "&quot;")}"`);
    }
    const children: string[] = [];
    for (const c of Array.from(node.childNodes)) {
      if (c.nodeType === Node.TEXT_NODE) {
        const t = (c.textContent ?? "").replace(/\s+/g, " ").trim();
        if (t) children.push(t.length > 300 ? t.slice(0, 297) + "…" : t);
      } else if (c.nodeType === Node.ELEMENT_NODE) {
        children.push(simplify(c as Element, depth + 1));
      }
    }
    const inner = children.filter(Boolean).join(" ");
    if (!inner && !["img", "input", "hr", "br", "video"].includes(tag)) return "";
    return `<${tag}${attrs.length ? " " + attrs.join(" ") : ""}>${inner}</${tag}>`;
  };
  let html = simplify(document.body, 0);
  if (html.length > 45_000) html = html.slice(0, 45_000) + "<!-- truncated -->";

  const outline: string[] = [];
  document.querySelectorAll("header, nav, main, section, footer, aside, h1, h2, h3").forEach((el) => {
    const t = (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
    if (t) outline.push(`${el.tagName.toLowerCase()}: ${t}`);
  });

  const links = Array.from(document.querySelectorAll("a[href]"))
    .map((a) => ({ text: (a.textContent ?? "").trim().slice(0, 60), href: (a as HTMLAnchorElement).href }))
    .filter((l) => l.text)
    .slice(0, 80);

  const images = Array.from(document.images)
    .filter((i) => i.naturalWidth > 24 && i.naturalHeight > 24 && !i.currentSrc.startsWith("data:"))
    .map((i) => ({ alt: i.alt.slice(0, 80), src: i.currentSrc, w: i.naturalWidth, h: i.naturalHeight }))
    .slice(0, 40);

  const fingerprints: string[] = [];
  const w = window as unknown as Record<string, unknown>;
  if (w.__NEXT_DATA__ || document.querySelector("#__next")) fingerprints.push("Next.js");
  if (w.__NUXT__ || document.querySelector("#__nuxt")) fingerprints.push("Nuxt");
  if (w.__remixContext) fingerprints.push("Remix");
  if (document.querySelector("[data-reactroot], #root")) fingerprints.push("React");
  if (w.Shopify) fingerprints.push("Shopify");
  if (document.querySelector('meta[name="generator"]')) fingerprints.push("generator: " + (document.querySelector('meta[name="generator"]') as HTMLMetaElement).content);
  if (document.querySelector("[class*='tailwind'], .flex.items-center")) fingerprints.push("Tailwind-style utility classes");
  if (w.wp || document.querySelector('link[href*="wp-content"]')) fingerprints.push("WordPress");
  if (w.webflow || document.querySelector("[data-wf-site]")) fingerprints.push("Webflow");
  if (document.querySelector("[data-framer-name]")) fingerprints.push("Framer");

  const main = document.querySelector("main, #root > *, body > div") as HTMLElement | null;
  const maxWidth = main ? getComputedStyle(main).maxWidth : null;
  // Page background: body, else html, else the biggest painted background. Transparent counts as white.
  const pageBg = [getComputedStyle(document.body).backgroundColor, getComputedStyle(document.documentElement).backgroundColor, top(backgrounds, 1)[0]]
    .find((c) => c && !isTransparent(c)) ?? "rgb(255, 255, 255)";
  const lum = (() => {
    const m = pageBg.match(/\d+/g);
    if (!m) return 1;
    const [r, g, b] = m.map(Number);
    return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  })();

  return {
    title: document.title,
    description: (document.querySelector('meta[name="description"]') as HTMLMetaElement | null)?.content ?? "",
    lang: document.documentElement.lang || "en",
    pageHeight: document.body.scrollHeight,
    html,
    tokens: {
      fonts: top(fonts, 4),
      colors: top(colors, 8),
      backgrounds: top(backgrounds, 8),
      radii: top(radii, 4),
      fontSizes: top(fontSizes, 8),
      maxWidth: maxWidth && maxWidth !== "none" ? maxWidth : null,
      darkMode: lum < 0.4,
      cssVars: {} as Record<string, string>,
    },
    outline: outline.slice(0, 60),
    links,
    images,
    fingerprints,
  };
}
