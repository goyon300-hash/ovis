import type { Locator, Page } from "playwright-core";

/**
 * Opens a tab as a user does at the page's width: the tab's own button in the row, which every width
 * draws (a phone's included), or, where the header's row is full, its entry in the list behind More.
 */
export async function pickTab(page: Page, tabId: string): Promise<void> {
  await clickTab(page, tabId);
}

/**
 * Opens a tab from the strip: its button in the row, or, where the header's row is full,
 * its entry in the list behind More (TabStrip). Waits for herdr's roster to list it. `untrusted`
 * clicks through the DOM, for a script that must not move the window's focus.
 */
export async function clickTab(page: Page, tabId: string, untrusted = false): Promise<void> {
  const press = (target: Locator): Promise<void> => untrusted ? target.evaluate((button: HTMLElement) => button.click()) : target.click();
  const inRow = `.tab-strip [role="tab"][data-tab-id="${tabId}"]`;
  // the tab comes before More in the strip: More first means the row has no room for it
  const first = page.locator(`${inRow}, .tab-strip-more`).first();
  if (!(await first.evaluate((node) => node.classList.contains("tab-strip-more")))) {
    await press(first);
    return;
  }
  await press(first);
  await press(page.locator(`${inRow}, [role="menu"] [data-item="tab:${tabId}"]`).first());
}
