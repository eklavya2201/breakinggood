
import assert from "node:assert/strict";
import test from "node:test";

import {
  CHALLENGE_MARKERS,
  dismissCookieBanners,
  extractRootCssVars,
  isChallengePage,
} from "./capture.js";

import type { Page } from "playwright-core";

test("returns the matched challenge marker from the page title", () => {
  for (const marker of CHALLENGE_MARKERS) {
    assert.equal(isChallengePage(marker, "Ordinary body content"), marker);
  }
});

test("detects challenge markers in short body text case-insensitively", () => {
  assert.equal(
    isChallengePage("Example site", "Please VERIFY YOU ARE HUMAN to continue."),
    "Verify you are human"
  );
  assert.equal(
    isChallengePage("Example site", "Enable JavaScript and cookies to proceed."),
    "Enable JavaScript and cookies"
  );
});

test("does not flag a long ordinary page that mentions challenge phrases", () => {
  const body = `A long article about web security. ${"Access denied and Just a moment are phrases sometimes discussed in documentation. ".repeat(30)}`;
  assert.ok(body.length >= 1500);
  assert.equal(isChallengePage("Example site", body), undefined);
});

test("detects Cloudflare challenge markup", () => {
  assert.equal(
    isChallengePage("Example site", "Ordinary page", '<form id="challenge-form"></form>'),
    "Cloudflare challenge markup"
  );
  assert.equal(
    isChallengePage("Example site", "Ordinary page", '<div class="cf-chl-widget"></div>'),
    "Cloudflare challenge markup"
  );
});

test("detects 403 and 503 navigation responses", () => {
  assert.equal(isChallengePage("Example site", "Ordinary page", "", 403), "HTTP 403 response");
  assert.equal(isChallengePage("Example site", "Ordinary page", "", 503), "HTTP 503 response");
});

test("does not flag ordinary pages", () => {
  assert.equal(isChallengePage("Example site", "Welcome to our website."), undefined);
  assert.equal(isChallengePage("", ""), undefined);
});

function cookiePage(options: { visibleSelector?: string; visibleLabel?: string }) {
  const selectorAttempts: string[] = [];
  const labelAttempts: { name: string; exact: boolean }[] = [];
  const clicks: string[] = [];

  const page = {
    locator(selector: string) {
      const locator = {
        async isVisible() {
          selectorAttempts.push(selector);
          return selector === options.visibleSelector;
        },
        async click() {
          clicks.push(selector);
        },
      };
      return { ...locator, first: () => locator };
    },
    getByRole(_role: string, query: { name: string; exact: boolean }) {
      const locator = {
        async isVisible() {
          labelAttempts.push(query);
          return query.name === options.visibleLabel;
        },
        async click() {
          clicks.push(query.name);
        },
      };
      return { ...locator, first: () => locator };
    },
    async waitForTimeout() {},
  } as unknown as Page;

  return { page, selectorAttempts, labelAttempts, clicks };
}

test("prefers known consent-tool selectors before button labels", async () => {
  const { page, selectorAttempts, labelAttempts, clicks } = cookiePage({
    visibleSelector: "#onetrust-accept-btn-handler",
    visibleLabel: "Accept all",
  });

  await dismissCookieBanners(page);

  assert.deepEqual(clicks, ["#onetrust-accept-btn-handler"]);
  assert.deepEqual(selectorAttempts, ["#onetrust-accept-btn-handler"]);
  assert.deepEqual(labelAttempts, []);
});

test("dismisses cookie banners with supported international labels", async () => {
  for (const label of [
    "Alle akzeptieren",
    "Akzeptieren",
    "Tout accepter",
    "Accepter",
    "Aceptar todo",
    "Aceptar",
    "Accetta tutto",
    "Aceitar",
  ]) {
    const { page, clicks, labelAttempts } = cookiePage({ visibleLabel: label });

    await dismissCookieBanners(page);

    assert.deepEqual(clicks, [label]);
    assert.ok(labelAttempts.some((attempt) => attempt.name === label && attempt.exact));
  }
});

test("matches short OK labels exactly", async () => {
  const { page, labelAttempts, clicks } = cookiePage({ visibleLabel: "OK" });

  await dismissCookieBanners(page);

  assert.deepEqual(clicks, ["OK"]);
  assert.ok(labelAttempts.some((attempt) => attempt.name === "OK" && attempt.exact));
});

test("captures relevant custom properties from :root and html rules", () => {
  const cssVars = extractRootCssVars([
    {
      selectorText: ":root, html",
      declarations: [
        ["--color-primary", " #2563eb "],
        ["--brand-500", "#0f172a"],
        ["--radius", "12px"],
        ["--font-body", "Inter, sans-serif"],
        ["--unrelated", "value"],
      ],
    },
    {
      selectorText: ".card",
      declarations: [["--color-card", "#ffffff"]],
    },
    {
      selectorText: "html.dark",
      declarations: [["--background", "#111827"]],
    },
  ]);

  assert.deepEqual(cssVars, {
    "--color-primary": "#2563eb",
    "--brand-500": "#0f172a",
    "--radius": "12px",
    "--font-body": "Inter, sans-serif",
    "--background": "#111827",
  });
});

test("limits captured custom properties to forty entries", () => {
  const declarations: [string, string][] = Array.from({ length: 45 }, (_, index) => [
    `--color-${index}`,
    `#${index.toString(16).padStart(6, "0")}`,
  ]);

  const cssVars = extractRootCssVars([{ selectorText: ":root", declarations }]);

  assert.equal(Object.keys(cssVars).length, 40);
});
