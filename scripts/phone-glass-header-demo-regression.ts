import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Page } from "playwright-core";
import panes from "../site/demo/fixtures/panes.json";
import { buildDemoApp } from "./demo-build.ts";
import { chromePath } from "./chrome-path.ts";
import { openLens } from "./header-lens.ts";

// A phone keeps full-width tabs and 44px targets at every size. Workspace context and the scoped
// action trigger live in the header, preserving space for a readable second tab. The secondary
// all-tabs sheet exposes full names, and keyboard/view-only states retain the same navigation.
type SocketsWindow = Window & { glassSockets: WebSocket[] };

/** Keeps the demo's sockets, so the check can turn this connection into a view-only one. */
function recordSockets(): void {
  const sockets: WebSocket[] = [];
  (window as SocketsWindow).glassSockets = sockets;
  const Demo = window.WebSocket;
  const Recorded = function (url: string | URL, protocols?: string | string[]) {
    const socket = new Demo(url, protocols);
    sockets.push(socket);
    return socket;
  };
  for (const name of ["CONNECTING", "OPEN", "CLOSING", "CLOSED"] as const) Object.defineProperty(Recorded, name, { value: Demo[name] });
  window.WebSocket = Recorded as unknown as typeof WebSocket;
}

const evidence = process.env.UI_EVIDENCE_DIR;
const app = mkdtempSync(join(tmpdir(), "ovis-phone-row-demo-"));
try {
  await buildDemoApp(app);
  const index = join(app, "index.html");
  const html = readFileSync(index, "utf8");
  assert.match(html, /<script type="module"/);
  writeFileSync(index, html.replace(/<script type="module"/, () => `<script src="./demo-transport.js"></script>\n<script>(${recordSockets.toString()})()</script>\n<script type="module"`));

  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (!path.startsWith("/herdr-web-ui/demo/app/")) return new Response("not found", { status: 404 });
    let file: string;
    try { file = decodeURIComponent(path.slice("/herdr-web-ui/demo/app/".length)); }
    catch { return new Response("bad path", { status: 400 }); }
    if (!file || file.endsWith("/")) file += "index.html";
    if (file.split("/").includes("..") || file.includes("\\")) return new Response("bad path", { status: 400 });
    const body = Bun.file(join(app, file));
    if (!(await body.exists())) return new Response("not found", { status: 404 });
    // Chromium on Linux has no phone status bar: give the header a phone's top inset, as the
    // installed app has, so the header's height is the one a phone draws.
    if (file.endsWith(".css")) return new Response((await body.text()).replace(/env\(safe-area-inset-top(?:,\s*0px)?\)/g, "32px"), { headers: { "content-type": "text/css" } });
    return new Response(body);
  } });
  try {
    const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
    try {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: "en-US" });
      try {
        await context.addInitScript(() => {
          localStorage.setItem("ovis:settings", JSON.stringify({ language: "en" }));
          const viewport = window.visualViewport!;
          let height = 795;
          Object.defineProperty(viewport, "height", { get: () => height });
          (window as Window & { glassViewport?: (value: number) => void }).glassViewport = (value) => {
            height = value;
            viewport.dispatchEvent(new Event("resize"));
          };
        });
        const page = await context.newPage();
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.goto(`http://127.0.0.1:${server.port}/herdr-web-ui/demo/app/?pane=${encodeURIComponent(panes.api)}`);
        await page.locator(".conn-live").waitFor();
        await page.locator(".tab-strip").waitFor();
        // a finished session and a running one: a phone's header counts neither beside More (the drawer says them)
        await page.evaluate(async () => {
          const { snapshot } = await (await fetch("/api/session")).json() as { snapshot: { panes: { pane_id: string; agent: string | null; agent_status: string }[] } };
          const idle = snapshot.panes.find((pane) => pane.agent && pane.agent_status === "idle");
          if (!idle) throw new Error("the demo has an idle agent to finish");
          const hooks = (window as unknown as { __herdrDemoOrder: { status(pane: string, status: string): void } }).__herdrDemoOrder;
          hooks.status(idle.pane_id, "done");
        });
        await page.locator('.sidebar .sidebar-status[data-status="done"]').first().waitFor({ state: "attached" });
        await page.locator('.sidebar .sidebar-status[data-status="working"]').first().waitFor({ state: "attached" });
        assert.equal(await page.locator(".app-header .header-counts, .app-header .header-count").count(), 0, "a phone's header counts no running or finished sessions");

        await openLens(page, "chat");
        const message = page.getByRole("textbox", { name: "Message", exact: true });
        await message.waitFor();

        const box = (selector: string) => page.evaluate((selector) => {
          const node = document.querySelector(selector);
          if (!node) return null;
          const { left, top, right, bottom, width, height } = node.getBoundingClientRect();
          return { left, top, right, bottom, width, height };
        }, selector);

        /** The row is drawn, its workspace's name and + are there, and the open tab is wholly in view. */
        const checkRow = async (label: string, height: number): Promise<void> => {
          const strip = await box(".tab-strip");
          assert.ok(strip, `${label}: the row is drawn`);
          assert.equal(Math.round(strip.height), height, `${label}: the row is ${height}px tall`);
          const chip = await box(".phone-workspace");
          assert.ok(chip && chip.width >= 44 && chip.height >= 44, `${label}: the workspace's name is a target (${JSON.stringify(chip)})`);
          assert.ok((await page.locator(".phone-workspace-name").textContent())?.trim(), `${label}: it names the workspace`);
          assert.ok(chip.bottom <= strip.top + 1, `${label}: workspace context is above the tabs`);
          assert.equal(Math.round(strip.width), await page.evaluate(() => innerWidth - 44), `${label}: tabs use the full width apart from +`);
          assert.equal(await page.locator(".tab-strip .tab-strip-menu, .tab-strip-workspace").count(), 0, `${label}: workspace and action controls consume no tab width`);
          const release = await page.locator('.tab-strip-item').nth(1).boundingBox();
          assert.ok(release && release.x >= strip.left && release.x + release.width <= strip.right, `${label}: the second tab is fully visible`);
          const add = await box(".tab-strip-add");
          assert.ok(add && add.width >= 44 && add.height >= 44, `${label}: the + is a target`);
          const row = await box(".tab-strip-row");
          assert.ok(row && add.right <= row.right + 1, `${label}: the + stays inside the row`);
          const active = await box(".tab-strip-item.is-active");
          assert.ok(active && active.left >= strip.left - 1 && active.right <= add.left + 1, `${label}: the open tab is wholly in view`);
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `${label}: nothing overflows sideways`);
          assert.equal(await page.locator(".app-header .context-tabs").count(), 0, `${label}: the title opens no list of tabs`);
          assert.equal(await page.locator(".app-header").evaluate((node) => getComputedStyle(node).backdropFilter), "none",
            `${label}: the header over the pane is the plain bar, the row between them`);
          if (evidence) {
            mkdirSync(evidence, { recursive: true });
            await page.screenshot({ path: join(evidence, `phone-row-${label}.png`) });
          }
        };

        await checkRow("390x844", 44);
        await page.locator(".phone-tab-menu").click();
        await page.locator('.row-sheet-item[data-item="all-tabs"]').click();
        const allTabs = page.locator('.row-sheet-item[data-item^="tab:"]');
        assert.equal(await allTabs.count(), 2, "the secondary list exposes both full tab names");
        await allTabs.nth(1).click();
        await page.waitForFunction(() => document.querySelector('.tab-strip-item.is-active .tab-strip-label')?.textContent === "release");
        await page.locator('.tab-strip [role="tab"]').first().click();
        await page.locator(".phone-tab-menu").click();
        await page.keyboard.press("Escape");
        await page.waitForFunction(() => document.activeElement?.classList.contains("phone-tab-menu"));
        await page.locator('.tab-strip [role="tab"]').nth(1).click({ button: "right" });
        await page.locator(".row-sheet").waitFor();
        assert.equal(await page.locator('.row-sheet-item[data-item="all-tabs"]').count(), 0, "a context menu keeps its target and does not mix in the active pane's application group");
        assert.equal(await page.locator('.tab-strip-item.is-active .tab-strip-label').textContent(), "Idempotent payments", "context-clicking an inactive tab does not select it");
        await page.keyboard.press("Escape");

        // Short phones retain full touch targets too.
        for (const [width, height, label] of [[320, 640, "320x640"], [360, 640, "360x640"], [390, 667, "390x667"]] as const) {
          await page.setViewportSize({ width, height });
          await page.waitForFunction(() => window.matchMedia("(max-width: 768px) and (max-height: 700px)").matches);
          await page.locator(".tab-strip").waitFor();
          await checkRow(label, 44);
        }

        // A landscape phone (wider than the sheets' breakpoint) keeps it too
        await page.setViewportSize({ width: 667, height: 375 });
        await page.locator(".tab-strip").waitFor();
        await checkRow("667x375", 44);

        // A tablet upright draws the full row
        await page.setViewportSize({ width: 700, height: 900 });
        await page.locator(".tab-strip").waitFor();
        await checkRow("700x900", 44);

        // The keyboard up: the row stays, and the composer stays above the keyboard
        await message.tap();
        await page.setViewportSize({ width: 390, height: 470 });
        await page.evaluate(() => (window as Window & { glassViewport?: (value: number) => void }).glassViewport?.(470));
        await page.waitForFunction(() => document.documentElement.hasAttribute("data-keyboard"));
        await checkRow("390x470-keyboard", 44);
        const composer = await box(".composer");
        assert.ok(composer && composer.bottom <= 471, `the composer stays above the keyboard (${JSON.stringify(composer)})`);

        // A view-only connection draws its "View only" banner below the header, never under it
        await page.evaluate(() => (window as SocketsWindow).glassSockets.at(-1)!.send(JSON.stringify({ type: "role", mode: "observe" })));
        await page.locator(".terminal-banner-observe:visible").first().waitFor();
        // Observe is a per-terminal socket mode, not a watch-only device permission. The
        // independent watch-device context below checks the HTTP mutation guards.
        const header = await box(".app-header");
        assert.ok(header, "the header has a box");
        const banners = await page.locator(".terminal-banners > :not(.visually-hidden)").evaluateAll((nodes) => nodes.map((node) => {
          const box = node.getBoundingClientRect();
          return { x: box.x, y: box.y, width: box.width, height: box.height, text: node.textContent?.trim() ?? "" };
        }).filter((box) => box.width > 0 && box.height > 0));
        assert.ok(banners.some((banner) => banner.text === "View only"), `the View only banner is drawn (${JSON.stringify(banners)})`);
        for (const banner of banners) {
          assert.ok(banner.y >= header.bottom - 0.5, `the banner "${banner.text}" starts below the header (bottom ${header.bottom})`);
        }
        assert.deepEqual(errors, []);
      } finally { await context.close(); }
      const watching = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: "en-US" });
      try {
        await watching.addInitScript(() => localStorage.setItem("ovis:settings", JSON.stringify({ language: "en" })));
        const page = await watching.newPage();
        await page.goto(`http://127.0.0.1:${server.port}/herdr-web-ui/demo/app/?demo_devices=watch&pane=${encodeURIComponent(panes.api)}`);
        await page.locator(".phone-tab-menu").waitFor();
        assert.equal(await page.locator(".tab-strip-add").isDisabled(), true, "watch-only device cannot create a terminal");
        await page.locator(".phone-tab-menu").click();
        await page.locator(".row-sheet").waitFor();
        assert.equal(await page.locator('.row-sheet-item[data-item="close-tab"]').count(), 0, "watch-only device offers no destructive tab close");
        assert.equal(await page.locator('.row-sheet-item[data-item="new-agent-tab"]').isDisabled(), true, "watch-only device cannot create an agent");
        await page.locator('.row-sheet-item[data-item="all-tabs"]').click();
        assert.equal(await page.locator('.row-sheet-item[data-item^="tab:"]').count(), 2, "watch-only still navigates the full-name tab list");
      } finally { await watching.close(); }
    } finally { await browser.close(); }
  } finally { await server.stop(true); }
  console.log("PASS phone tab row: drawn at 390x844, 320x640, 360x640, 390x667, 667x375, 700x900 and with the keyboard up, 44px targets and readable second tab, header workspace and scoped actions, full-name picker and focus return, view-only guards, and no page errors");
} finally {
  rmSync(app, { recursive: true, force: true });
}
