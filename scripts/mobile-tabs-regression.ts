import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser, Locator, Page } from "playwright-core";
import { appFaces } from "./app-faces.ts";
import { herdrRpc, paneSplit, tabClose, tabCreate, workspaceClose, workspaceCreate } from "../server/herdr/client.ts";
import { chromePath } from "./chrome-path.ts";
import { openLens } from "./header-lens.ts";

type Box = { left: number; top: number; right: number; bottom: number; width: number; height: number };
type KeyboardQA = Window & { keyboardQA: (height: number | null) => void };

const TAB_LABELS = ["second", "a long tab name for review", "deploy", "release notes draft", "perf investigation", "docs"];
/** Where a touch screen still draws the tab row: wider than a phone (the sheets' 640px), as a tablet's portrait. */
const TABLET = { width: 700, height: 900 };

async function box(page: Page, selector: string): Promise<Box> {
  const found = await page.evaluate((selector) => {
    const node = document.querySelector(selector);
    if (!node) return null;
    const { left, top, right, bottom, width, height } = node.getBoundingClientRect();
    return { left, top, right, bottom, width, height };
  }, selector);
  assert.ok(found, `${selector} is on the page`);
  return found;
}

/**
 * A phone's shell: one header row over a tab row that is always drawn, workspace context in the
 * header, and no list of tabs behind the title (the row is the one way to them).
 */
async function assertShell(page: Page, label: string, titleRoom = 60, rowHeight = 44): Promise<void> {
  assert.equal(await page.locator(".app-header").getByRole("button", { name: "New tab" }).count(), 0, `${label}: the header has no New tab button of its own`);
  assert.equal(await page.locator(".app-header .header-more-button").isVisible(), true, `${label}: the header keeps its More menu`);
  const title = await box(page, ".phone-workspace-name");
  assert.ok(title.width >= titleRoom, `${label}: the pane's title keeps its room in the header (${title.width}px)`);
  assert.equal(await page.locator(".app-header .context-tabs").count(), 0, `${label}: the title opens no list of tabs`);
  assert.ok((await box(page, ".app-header")).height <= 56, `${label}: the header is one row`);
  const strip = await box(page, ".tab-strip");
  assert.equal(Math.round(strip.height), rowHeight, `${label}: the tab row is ${rowHeight}px tall (${strip.height}px)`);
  assert.ok(strip.top >= (await box(page, ".app-header")).bottom - 1, `${label}: the row sits under the header`);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `${label}: nothing overflows sideways`);
}

/** The workspace's name in the header: a finger's target that opens the workspace drawer. */
async function assertWorkspaceChip(page: Page, label: string, name: string): Promise<void> {
  const chip = page.locator(".phone-workspace");
  assert.equal(await chip.count(), 1, `${label}: the header names the workspace`);
  assert.equal((await chip.locator(".phone-workspace-name").textContent())?.trim(), name, `${label}: it names the workspace`);
  const found = await box(page, ".phone-workspace");
  assert.ok(found.height >= 36 && found.width >= 44, `${label}: the workspace is a touch target (${found.width}x${found.height})`);
  assert.ok(found.bottom <= (await box(page, ".tab-strip")).top + 1, `${label}: workspace context is in the header, not the tab row`);
}

/** The open tab and the + are both inside the strip's visible part, and the + is not over the tab. */
async function activeTabInView(page: Page, label: string): Promise<void> {
  await page.waitForFunction(() => {
    const strip = document.querySelector(".tab-strip")?.getBoundingClientRect();
    const row = document.querySelector(".tab-strip-row")?.getBoundingClientRect();
    const active = document.querySelector(".tab-strip-item.is-active")?.getBoundingClientRect();
    const add = document.querySelector(".tab-strip-add")?.getBoundingClientRect();
    if (!strip || !row || !active || !add) return false;
    return active.left >= strip.left - 1 && active.right <= add.left + 1 && add.right <= row.right + 1;
  }, null, { timeout: 5_000 }).catch(async (cause) => {
    throw new Error(`${label}: expected the open tab and the + in view; observed ${JSON.stringify({
      strip: await box(page, ".tab-strip"), active: await box(page, ".tab-strip-item.is-active"), add: await box(page, ".tab-strip-add"),
      maxW: await page.evaluate(() => getComputedStyle(document.querySelector(".tab-strip-item.is-active")!).maxWidth),
      row: await page.evaluate(() => document.querySelector(".tab-strip-row")?.className),
      scroll: await page.evaluate(() => document.querySelector(".tab-strip")?.scrollLeft),
    })}`, { cause });
  });
}

/** A tab of the row, by the name it draws. */
function tab(page: Page, name: string): Locator {
  return page.locator(".tab-strip-item").filter({ has: page.locator(".tab-strip-label", { hasText: name }) });
}

/** One tap on a tab's name opens it: no list, no second press. */
async function pickTab(page: Page, name: string): Promise<void> {
  await tab(page, name).locator(".tab-strip-tab").tap();
}

/** A phone's row, its tabs, and the workspace's name that opens the drawer. */
export async function checkMobileTabs(browser: Browser, origin: string): Promise<void> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ovis-mobile-tabs-")));
  let workspaceId: string | null = null;
  let otherWorkspaceId: string | null = null;
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: "en-US" });
  try {
    const created = await workspaceCreate({ cwd: root, label: "ovis-test-mobile-tabs" });
    workspaceId = created.workspace.workspace_id;
    const first = created.root_pane.pane_id;
    // herdr keeps the first pane in front: the split one is seen only where the browser opens it
    const second = (await paneSplit(first, "right", false)).pane_id;
    const other = await workspaceCreate({ cwd: root, label: "ovis-test-mobile-tabs-other" });
    otherWorkspaceId = other.workspace.workspace_id;
    const panes: string[] = [];
    for (const label of TAB_LABELS) panes.push((await tabCreate({ workspaceId, cwd: root, label })).root_pane.pane_id);
    const last = panes.at(-1)!;
    await herdrRpc("pane.report_agent", { pane_id: first, source: "manual", agent: "claude", state: "idle" });

    await context.addInitScript(() => {
      if (localStorage.getItem("ovis:settings") === null) localStorage.setItem("ovis:settings", JSON.stringify({ language: "en" }));
      const viewport = window.visualViewport!;
      let height: number | null = null;
      Object.defineProperty(viewport, "height", { get: () => height ?? window.innerHeight });
      (window as unknown as KeyboardQA).keyboardQA = (value) => { height = value; viewport.dispatchEvent(new Event("resize")); };
    });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const evidence = process.env.UI_EVIDENCE_DIR;
    if (evidence) mkdirSync(evidence, { recursive: true });
    const screenshot = async (name: string): Promise<void> => {
      if (evidence) await page.screenshot({ path: join(evidence, `mobile-tabs-${name}.png`), animations: "disabled" });
    };

    await page.goto(`${origin}/?pane=${encodeURIComponent(first)}`);
    await page.locator(".conn-live").waitFor();
    await page.locator(".tab-strip").waitFor();
    await openLens(page, "chat");
    const firstFrame = page.locator(`[data-layout-pane=${JSON.stringify(first)}]`);
    const composer = firstFrame.getByRole("textbox", { name: "Message", exact: true });
    await composer.waitFor();
    await assertShell(page, "chat");
    await assertWorkspaceChip(page, "chat", "ovis-test-mobile-tabs");
    await screenshot("chat");

    // The row: every tab in herdr's order, the open one marked, a finger's target each, and the + at
    // its end. A tab herdr names by its number draws its pane's title instead, the number kept before it.
    const items = page.locator(".tab-strip-item");
    assert.equal(await items.count(), TAB_LABELS.length + 1, "the row holds every tab of the workspace");
    assert.deepEqual(await page.locator(".tab-strip-label").allTextContents(), [await page.locator(".tab-strip-item.is-active .tab-strip-label").textContent(), ...TAB_LABELS],
      "the tabs keep herdr's order, the first named by its pane");
    assert.equal(await page.locator(".tab-strip-number").count(), 0, "a name no other tab shares needs no number before it");
    assert.equal(await page.locator(".phone-tab-menu").isVisible(), true, "the open tab carries its menu");
    assert.equal(await page.locator(".phone-tab-menu:visible").count(), 1, "only the open tab exposes a menu");
    const sizes = await items.evaluateAll((nodes) => nodes.map((node) => { const rect = node.getBoundingClientRect(); return { w: rect.width, h: rect.height }; }));
    assert.ok(sizes.every((size) => size.h >= 44 && size.w >= 44), `every tab is a touch target (${JSON.stringify(sizes)})`);
    const add = await box(page, ".tab-strip-add");
    assert.ok(add.width >= 44 && add.height >= 44, "the + is a touch target");
    assert.ok(add.right <= (await box(page, ".tab-strip-row")).right + 1, "the + stays inside the row");
    await activeTabInView(page, "the first tab");
    await screenshot("tabs");

    // Two tabs of one folder read alike: herdr's own number comes before each name, so they tell apart
    const twin = await tabCreate({ workspaceId, cwd: root });
    try {
      await page.waitForFunction(() => document.querySelectorAll(".tab-strip-item").length === 8);
      await page.waitForFunction(() => document.querySelectorAll(".tab-strip-number").length === 2);
      assert.deepEqual(await page.locator(".tab-strip-number").allTextContents(), ["1", "8"], "two tabs of one folder keep herdr's number before their names");
    } finally { await tabClose(twin.tab.tab_id); }
    await page.waitForFunction(() => document.querySelectorAll(".tab-strip-item").length === 7);

    // One tap opens a tab, and the row brings it into view: no list, no second press
    await pickTab(page, "docs");
    await page.locator(`[data-layout-pane=${JSON.stringify(last)}]`).waitFor({ state: "visible" });
    assert.equal(await page.locator(".tab-strip-item.is-active .tab-strip-label").textContent(), "docs", "the tab tapped is the open one");
    await activeTabInView(page, "a tab picked at the row's end");
    await screenshot("last-tab");

    // The row scrolls sideways on its own, and a vertical stroke begun on it is the page's
    const scrolls = await page.evaluate(() => { const strip = document.querySelector(".tab-strip")!; return strip.scrollWidth > strip.clientWidth; });
    assert.equal(scrolls, true, "more tabs than fit make the row scroll");
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector(".tab-strip")!).overscrollBehaviorX), "contain", "the row keeps its sideways scroll to itself");
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector(".tab-strip")!).overflowY), "hidden", "the row is no vertical scroller: a vertical stroke is the page's");

    // The open tab's menu: the tab's panes first where it has more than one, then its actions
    await pickTab(page, await page.locator(".tab-strip-item").first().locator(".tab-strip-label").textContent() ?? "");
    await page.locator(`[data-layout-pane=${JSON.stringify(first)}]`).waitFor({ state: "visible" });
    await page.locator(".phone-tab-menu").tap();
    const menu = page.getByRole("dialog", { name: /./ }).first();
    await menu.waitFor();
    const ids = await menu.locator(".row-sheet-item").evaluateAll((nodes) => nodes.map((node) => (node as HTMLElement).dataset["item"] ?? ""));
    assert.ok(ids.filter((id) => id.startsWith("pane:")).length === 2, `a split tab's two panes lead its menu (${ids.join(", ")})`);
    assert.ok(ids.includes("close-tab"), "the tab is closed from its menu");
    await page.keyboard.press("Escape");
    await menu.waitFor({ state: "detached" });

    // The 1/2 chip picks the tab's other pane: one tap to the list, one to the pane
    const position = page.locator(".context-position.is-picker");
    assert.equal(await position.count(), 1, "a split tab's place is a picker");
    assert.ok((await box(page, ".context-position.is-picker")).height >= 44, "the picker is a touch target");
    const stableName = await page.locator(".tab-strip-item.is-active .tab-strip-label").textContent();
    assert.match(await position.getAttribute("aria-label") ?? "", /Panes · [12]\/2/, "the chip counts panes, not workspace tabs");
    await position.tap();
    const paneList = page.getByRole("dialog", { name: /./ }).first();
    await paneList.waitFor();
    assert.equal(await paneList.locator(".row-sheet-item").count(), 2, "the picker lists the tab's panes");
    await paneList.locator(".row-sheet-item").nth(1).tap();
    await page.locator(`[data-layout-pane=${JSON.stringify(second)}]`).waitFor({ state: "visible" });
    assert.equal(await page.locator(".tab-strip-item.is-active .tab-strip-label").textContent(), stableName, "picking another pane keeps the fallback tab name stable");
    // back to the first pane, which the rest of the check types into
    await position.tap();
    await page.getByRole("dialog", { name: /./ }).first().locator(".row-sheet-item").first().tap();
    await page.locator(`[data-layout-pane=${JSON.stringify(first)}]`).waitFor({ state: "visible" });

    // The workspace's name opens the drawer, and the drawer closes again
    await page.locator(".phone-workspace").tap();
    await page.locator("#workspace-drawer.is-open").waitFor();
    await page.locator("#drawer-toggle").tap();
    await page.locator("#workspace-drawer.is-open").waitFor({ state: "detached" });

    // The keyboard up: the row stays, and the composer stays above the keyboard
    await openLens(page, "chat");
    await composer.tap();
    await page.evaluate(() => (window as unknown as KeyboardQA).keyboardQA(480));
    await page.waitForFunction(() => document.documentElement.hasAttribute("data-keyboard") && Math.round(document.querySelector(".app")!.getBoundingClientRect().height) === 480);
    await assertShell(page, "chat with the keyboard up");
    assert.ok((await box(page, ".composer")).bottom <= 481, "the composer stays above the keyboard");
    await screenshot("chat-keyboard");
    await page.evaluate(() => { (document.activeElement as HTMLElement | null)?.blur(); (window as unknown as KeyboardQA).keyboardQA(null); });
    await page.waitForFunction(() => !document.documentElement.hasAttribute("data-keyboard"));

    // The terminal lens keeps the row and the selected split pane.
    await openLens(page, "terminal");
    await firstFrame.locator(".key-bar").waitFor();
    assert.equal(await page.locator(".pane-frame:visible").count(), 1, "a phone shows the split tab's open pane alone");
    assert.equal(await page.locator(`[data-layout-pane=${JSON.stringify(first)}]`).count(), 1, "the open pane stays mounted");
    assert.equal(await page.locator(`[data-layout-pane=${JSON.stringify(second)}]`).count(), 1, "and its sibling stays mounted");
    await assertShell(page, "terminal");
    await screenshot("terminal");

    // The pane a tab and a workspace row were last seen on outlives a reload (a phone drops a page
    // left in the background): both open the split pane last seen, not the one herdr has in front.
    const shown = (pane: string) => page.locator(`[data-layout-pane=${JSON.stringify(pane)}]`).waitFor({ state: "visible" });
    await page.goto(`${origin}/?pane=${encodeURIComponent(second)}`);
    await page.locator(".conn-live").waitFor();
    await shown(second);
    await pickTab(page, "docs");
    await shown(last);
    await page.reload();
    await page.locator(".conn-live").waitFor();
    await shown(last);
    await pickTab(page, await page.locator(".tab-strip-item").first().locator(".tab-strip-label").textContent() ?? "");
    await shown(second);
    assert.equal(await page.locator(`[data-layout-pane=${JSON.stringify(first)}]`).isVisible(), false, "a tab opened again after a reload shows the pane it was left on");
    await page.goto(`${origin}/?pane=${encodeURIComponent(other.root_pane.pane_id)}`);
    await page.locator(".conn-live").waitFor();
    await page.reload();
    await page.locator(".conn-live").waitFor();
    await page.getByRole("button", { name: "Open workspace list", exact: true }).tap();
    await page.locator(`.workspace-group[data-workspace=${JSON.stringify(workspaceId)}] > .workspace-header .workspace-select`).tap();
    await shown(second);
    assert.equal(await page.locator(`[data-layout-pane=${JSON.stringify(first)}]`).isVisible(), false, "a workspace row picked after a reload opens the pane it was left on");

    // Every phone size keeps the row, its workspace's name and its +, and nothing overflows. A short
    // screen retains 44px targets; workspace context stays in the header.
    for (const [width, height, rowHeight] of [[320, 640, 44], [360, 640, 44], [390, 667, 44], [390, 844, 44]] as const) {
      const label = `a ${width}x${height} phone`;
      await page.setViewportSize({ width, height });
      await page.locator(".tab-strip").waitFor();
      await assertShell(page, label, 0, rowHeight);
      await assertWorkspaceChip(page, label, "ovis-test-mobile-tabs");
      await activeTabInView(page, label);
      await screenshot(`narrow-${width}x${height}`);
    }

    // Wider than a phone a touch screen keeps the row: the open tab's own touch menu beside its name
    await page.setViewportSize(TABLET);
    await page.locator(".tab-strip").waitFor();
    assert.equal(await page.locator(".app-header .context-tabs").count(), 0, "the title opens no list where the row is drawn");
    assert.equal(await page.locator(".tab-strip-close, .tab-strip-panes").count(), 0, "tabs have no close buttons or chevrons");
    assert.equal(await page.locator(".phone-tab-menu:visible").count(), 1, "only the active tab exposes a touch menu");
    const menuBox = await box(page, ".phone-tab-menu");
    assert.ok(menuBox.bottom <= (await box(page, ".tab-strip")).top + 1, "the scoped tab menu is in the header, leaving the row to the tabs");
    assert.ok(menuBox.width >= 40 && menuBox.height >= 40, "the tab menu button is a touch target");
    assert.ok((await box(page, ".tab-strip")).height >= 40, "the strip is a touch target tall");
    await activeTabInView(page, "a tablet's strip");
    assert.deepEqual(errors, []);

    // The app's faces come after the first paint (src/fonts/fonts.css, font-display: swap) and
    // every tab's name is redrawn with them, wider or narrower: the strip that brought the open
    // tab into view in the fallback brings it into view again. The font files are held here until
    // the fallback drawing is seen; no service worker, so that nothing answers them from a cache.
    // A strip the user scrolled themselves, to look at other tabs, is left where they put it by a
    // face that comes after: the scroll below is not the strip's own, which is all the app can
    // know of a wheel or a drag. Opening a tab ends that.
    for (const scrolled of [false, true]) {
      const slow = await browser.newContext({ viewport: TABLET, isMobile: true, hasTouch: true, locale: "en-US", serviceWorkers: "block" });
      try {
        await slow.addInitScript(() => localStorage.setItem("ovis:settings", JSON.stringify({ language: "en" })));
        const late = await slow.newPage();
        const lateErrors: string[] = [];
        late.on("pageerror", (error) => lateErrors.push(error.message));
        let release = (): void => undefined;
        const released = new Promise<void>((done) => { release = done; });
        await late.route("**/*.woff2", async (route) => { await released; await route.continue().catch(() => undefined); });
        const strip = late.locator(".tab-strip");
        const openInView = (): Promise<boolean> => strip.evaluate((node) => {
          const item = node.querySelector(".tab-strip-item.is-active")!.getBoundingClientRect();
          const add = (node.closest(".tab-strip-row") ?? node).querySelector(".tab-strip-add")!.getBoundingClientRect();
          return item.left >= node.getBoundingClientRect().left - 1 && item.right <= add.left + 1;
        });
        try {
          await late.goto(`${origin}/?pane=${encodeURIComponent(last)}`);
          await late.locator(".conn-live").waitFor();
          await late.locator('.tab-strip [role="tab"][aria-selected="true"]', { hasText: "docs" }).waitFor();
          assert.equal(await late.evaluate(() => [...document.fonts].filter((face) => face.family.replace(/["']/g, "") === "Pretendard Variable" && face.status === "loaded").length), 0, "the strip is first drawn before its face comes");
          await activeTabInView(late, "the last tab, before the faces came");
          if (scrolled) {
            await strip.evaluate((node) => { node.scrollLeft = 0; });
            await late.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
            assert.equal(await openInView(), false, "the user scrolled the strip away from the open tab");
          }
        } finally { release(); }
        await appFaces(late);
        if (scrolled) {
          assert.equal(await strip.evaluate((node) => node.scrollLeft), 0, "a strip the user scrolled is left there when the faces come");
          assert.equal(await openInView(), false);
          await late.getByRole("tab", { name: "docs", exact: true }).tap();
          await late.locator('.tab-strip [role="tab"][aria-selected="true"]', { hasText: "docs" }).waitFor();
          await activeTabInView(late, "a tab opened after the user's scroll");
        } else {
          await activeTabInView(late, "the last tab, after the faces came");
        }
        assert.deepEqual(lateErrors, []);
      } finally { await slow.close(); }
    }
    console.log("PASS a phone separates header workspace context from full-width tabs, opens a tab in one tap, keeps the open tab in view, picks a split tab's pane from the 1/2 chip, and keeps the row with the keyboard up and at 320px");
  } finally {
    await context.close();
    if (workspaceId) await workspaceClose(workspaceId).catch(() => undefined);
    if (otherWorkspaceId) await workspaceClose(otherWorkspaceId).catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  await import("./test-herdr.ts");
  const { chromium } = await import("playwright-core");
  const { createServer } = await import("../server/index.ts");
  const { UsageService } = await import("../server/usage.ts");
  const state = mkdtempSync(join(tmpdir(), "ovis-mobile-tabs-state-"));
  const server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: state, usage: new UsageService(undefined, []) });
  const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
  try {
    await checkMobileTabs(browser, `http://127.0.0.1:${server.port}`);
  } finally {
    await browser.close();
    server.stop();
    rmSync(state, { recursive: true, force: true });
  }
}
