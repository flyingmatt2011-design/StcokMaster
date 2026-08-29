import { expect, test, type Page } from '@playwright/test';

const smokePassword = process.env.DSA_WEB_SMOKE_PASSWORD;

if (!smokePassword) {
  test.skip(true, 'Set DSA_WEB_SMOKE_PASSWORD to run authenticated smoke tests.');
}

async function waitForLoginOrHome(page: Page): Promise<'login' | 'home'> {
  const password = page.locator('#password');
  await expect
    .poll(async () => {
      const pathname = new URL(page.url()).pathname;
      if (pathname === '/' && await page.getByTestId('stockmaster-shell').isVisible().catch(() => false)) {
        return 'home';
      }
      if (await password.isVisible().catch(() => false)) return 'login';
      return 'pending';
    }, { timeout: 15_000 })
    .not.toBe('pending');
  return new URL(page.url()).pathname === '/' ? 'home' : 'login';
}

async function login(page: Page) {
  test.skip(!smokePassword, 'Set DSA_WEB_SMOKE_PASSWORD to run authenticated smoke tests.');
  await page.goto('/login');
  await page.waitForLoadState('domcontentloaded');
  if (await waitForLoginOrHome(page) === 'home') return;

  await expect(page.locator('#password')).toBeVisible({ timeout: 10_000 });
  await page.locator('#password').fill(smokePassword!);
  const confirmation = page.locator('#passwordConfirm');
  if (await confirmation.isVisible().catch(() => false)) {
    await confirmation.fill(smokePassword!);
  }

  const submitButton = page.getByRole('button', { name: /授权进入工作台|完成设置并登录/ });
  await Promise.all([
    page.waitForResponse(
      (response) => response.url().includes('/api/v1/auth/login') && response.status() === 200,
      { timeout: 15_000 },
    ),
    submitButton.click(),
  ]);
  await page.waitForURL('/', { timeout: 15_000 });
}

test.describe('StockMaster web smoke', () => {
  test.use({ locale: 'zh-CN' });

  test('login route respects authentication mode and StockMaster branding', async ({ page }) => {
    await page.goto('/login');
    const authState = await waitForLoginOrHome(page);
    await expect(page.getByText('StockMaster', { exact: true })).toBeVisible();
    if (authState === 'home') {
      await expect(page.getByTestId('stockmaster-shell')).toBeVisible();
    } else {
      await expect(page.locator('#password')).toBeVisible();
      await expect(page.getByRole('button', { name: /授权进入工作台|完成设置并登录/ })).toBeVisible();
    }
  });

  test('home page exposes the compact watchlist workspace', async ({ page }) => {
    await login(page);
    await expect(page.getByTestId('stockmaster-shell')).toBeVisible({ timeout: 10_000 });
    // The first Vite request cold-compiles the large HomePage chunk in local smoke runs.
    await expect(page.getByTestId('home-stock-workspace')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('heading', { name: '自选股盯盘' })).toBeVisible();
    await expect(page.getByLabel('添加代码，如 600519')).toBeVisible();
    await expect(page.getByTestId('watchlist-select-all')).toBeVisible();
    await expect(page.getByTestId('watchlist-analyze-selected')).toBeVisible();
  });

  test('desktop navigation contains only the three StockMaster destinations', async ({ page }) => {
    await login(page);
    const nav = page.getByRole('navigation', { name: '主导航' });
    await expect(nav.getByRole('link', { name: '首页 / 自选股' })).toBeVisible();
    await expect(nav.getByRole('link', { name: '持仓' })).toBeVisible();
    await expect(nav.getByRole('link', { name: '设置' })).toBeVisible();
    await expect(nav.getByRole('link')).toHaveCount(3);
  });

  test('holdings page renders without route or layout errors', async ({ page }) => {
    await login(page);
    await page.getByRole('link', { name: '持仓' }).click();
    await expect(page).toHaveURL(/\/portfolio$/);
    await expect(page.getByRole('heading', { name: '持仓' })).toBeVisible({ timeout: 10_000 });
  });

  test('settings page exposes provider and news configuration', async ({ page }) => {
    await login(page);
    await page.getByRole('link', { name: '设置' }).click();
    await expect(page).toHaveURL(/\/settings$/);
    await expect(page.getByRole('heading', { name: '设置' })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('stockmaster-news-search-settings')).toBeVisible();
    await expect(page.getByTestId('stockmaster-provider-settings')).toBeVisible();
    await expect(page.getByRole('button', { name: '基础设置' })).toBeVisible();
    await expect(page.getByRole('button', { name: '高级设置' })).toBeVisible();
  });

  test('mobile shell opens the three-item navigation drawer', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await login(page);
    await page.getByRole('button', { name: '打开导航' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('link', { name: '首页 / 自选股' })).toBeVisible();
    await expect(dialog.getByRole('link', { name: '持仓' })).toBeVisible();
    await expect(dialog.getByRole('link', { name: '设置' })).toBeVisible();
  });

  test('language switch updates navigation and persists after reload', async ({ page }) => {
    await login(page);
    await page.getByRole('button', { name: '切换界面语言' }).click();
    await expect(page.getByRole('link', { name: 'Home / Watchlist' })).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem('dsa.uiLanguage'))).toBe('en');
    await page.reload();
    await expect(page.getByRole('link', { name: 'Settings' })).toBeVisible();
  });
});
