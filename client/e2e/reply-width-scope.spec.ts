import { test, expect, type Page } from '@playwright/test';
import type { ViteDevServer } from 'vite';
import { createServer } from './fixtures/vite.js';
let server: ViteDevServer;
test.beforeAll(async () => { server = await createServer({ server: { host: '127.0.0.1', port: 0 } }); await server.listen(); });
test.afterAll(async () => { await server?.close(); });

const control = (page: Page, name: string) => page.locator(`[data-case="${name}"] .native-run-width`);
const widths = (page: Page) => page.locator('[data-case]').evaluateAll(nodes => Object.fromEntries(nodes.map(node => [node.getAttribute('data-case')!, Math.round(node.querySelector('article')!.getBoundingClientRect().width)])));

test('one widened reply does not widen the same message ID on another host, device or conversation', async ({ page }) => {
  await page.setViewportSize({ width: 1500, height: 1000 });
  await page.goto(server.resolvedUrls!.local[0] + 'e2e/fixtures/reply-width.html');
  await expect(control(page, 'first')).toBeVisible();
  // Rendered away from the desktop main list, or as a subagent / background card, a reply has no control.
  await expect(page.locator('[data-case="scoped task"] .native-run')).toBeVisible(); await expect(control(page, 'scoped task')).toHaveCount(0);
  await expect(page.locator('[data-case="outside the main list"] .native-run')).toBeVisible(); await expect(control(page, 'outside the main list')).toHaveCount(0);
  const narrow = await widths(page);
  for (const name of Object.keys(narrow)) expect(narrow[name]).toBe(760);

  await control(page, 'other host').click();
  await expect(control(page, 'other host')).toHaveAttribute('aria-pressed', 'true');
  for (const name of ['first', 'same reply again', 'other device', 'other conversation']) await expect(control(page, name)).toHaveAttribute('aria-pressed', 'false');
  expect(await widths(page)).toEqual({ ...narrow, 'other host': 1460 });

  // The key is the reply, not the card instance: a second view of it follows.
  await control(page, 'first').click();
  for (const name of ['first', 'same reply again', 'other host']) await expect(control(page, name)).toHaveAttribute('aria-pressed', 'true');
  for (const name of ['other device', 'other conversation']) await expect(control(page, name)).toHaveAttribute('aria-pressed', 'false');
  expect(await widths(page)).toEqual({ ...narrow, first: 1460, 'same reply again': 1460, 'other host': 1460 });
  await control(page, 'other host').click();
  await expect(control(page, 'other host')).toHaveAttribute('aria-pressed', 'false'); await expect(control(page, 'first')).toHaveAttribute('aria-pressed', 'true');
  await control(page, 'same reply again').click();
  await expect(control(page, 'first')).toHaveAttribute('aria-pressed', 'false');
  expect(await widths(page)).toEqual(narrow);
  // Only rows whose own control was used are handed back to the list for measurement.
  expect(await page.evaluate(() => (window as unknown as { replyWidthFixture: { measured: string[] } }).replyWidthFixture.measured)).toEqual(['other host', 'first', 'same reply again']);
});
