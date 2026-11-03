import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'

const publicRoutes = [
  { path: '/', name: 'home' },
  { path: '/what-we-scan', name: 'what-we-scan' },
  { path: '/how-it-works', name: 'how-it-works' },
  { path: '/privacy', name: 'privacy' },
  { path: '/about', name: 'about' },
]

for (const route of publicRoutes) {
  test(`${route.path} renders accessibly and has a screenshot`, async ({ page }, testInfo) => {
    await page.goto(route.path)
    await expect(page.locator('main h1')).toBeVisible()

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'wcag2aaa', 'wcag21aaa', 'wcag22aaa'])
      .analyze()
    expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([])

    await page.screenshot({
      path: testInfo.outputPath('screenshots', `${route.name}-desktop.png`),
      fullPage: true,
    })
  })

  for (const theme of ['dark', 'high-contrast']) {
    test(`${route.path} passes axe in ${theme} theme`, async ({ page }) => {
      await page.goto(route.path)
      await page.getByRole('combobox', { name: 'Theme' }).selectOption(theme)

      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'wcag2aaa', 'wcag21aaa', 'wcag22aaa'])
        .analyze()
      expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([])
    })
  }
}

test('workspace stays usable on mobile and has a screenshot', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Make accessibility part of every release.' })).toBeVisible()
  await expect(page.getByLabel('Web page URL')).toBeVisible()

  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'wcag2aaa', 'wcag21aaa', 'wcag22aaa'])
    .analyze()
  expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([])

  await page.screenshot({
    path: testInfo.outputPath('screenshots', 'workspace-mobile.png'),
    fullPage: true,
  })
})

for (const route of publicRoutes) {
  test(`Sign in on ${route.path} opens the preview using the keyboard`, async ({ page }) => {
    await page.goto(route.path)
    await page.getByRole('link', { name: 'Sign in', exact: true }).focus()
    await page.keyboard.press('Enter')
    await expect(page).toHaveURL('/?preview=1#preview')
    await expect(page.getByRole('tab', { name: 'Autonomous PR' })).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByRole('tab', { name: 'Autonomous PR' })).toBeFocused()
    await expect(page.getByRole('button', { name: 'Sign in with Entra ID B2C' })).toBeVisible()
  })
}

test('dark primary hover and scan errors retain enhanced text contrast', async ({ page }) => {
  await page.route('**/api/v1/scans/web', (route) => route.fulfill({
    status: 400,
    json: { error: 'The scan could not be completed.' },
  }))
  await page.goto('/')
  await page.getByRole('combobox', { name: 'Theme' }).selectOption('dark')
  await page.getByRole('link', { name: 'Start a free audit' }).hover()
  // Wait for the hover transition before checking the rendered color.
  await expect(page.getByRole('link', { name: 'Start a free audit' })).toHaveCSS('background-color', 'rgb(6, 72, 61)')
  await page.getByLabel('Web page URL').fill('https://example.com')
  await page.getByRole('button', { name: 'Analyze', exact: true }).click()
  await expect(page.getByRole('alert')).toHaveText('The scan could not be completed.')
  await page.getByRole('button', { name: 'Analyze', exact: true }).hover()
  const results = await new AxeBuilder({ page })
    .withRules(['color-contrast', 'color-contrast-enhanced'])
    .analyze()
  expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([])
})

async function mockMsal(page: Page, tokenFailure = false) {
  await page.route('**/node_modules/.vite/deps/@azure_msal-react.js*', (route) => route.fulfill({
    contentType: 'application/javascript',
    body: `
      const accounts = [{ homeAccountId: 'test-account', username: 'test@example.com' }];
      const instance = {
        acquireTokenSilent: async ({ account, scopes }) => {
          if (account !== accounts[0] || !scopes.length) throw new Error('Missing token request account or scopes');
          ${tokenFailure ? "throw new Error('Test token acquisition failed.');" : "return { accessToken: 'test-api-access-token' };"}
        }
      };
      export const useMsal = () => ({ instance, accounts });
      export const useIsAuthenticated = () => true;
      export const MsalProvider = ({ children }) => children;
    `,
  }))
  await page.route('**/api/v1/users/me', (route) => route.fulfill({
    json: { featureFlags: { autoRemediationPrPreview: false } },
  }))
}

for (const signedIn of [false, true]) {
  for (const mode of ['web', 'repo']) {
    test(`${signedIn ? 'signed-in' : 'anonymous'} ${mode} scan and media send expected authorization and badge URL`, async ({ page }) => {
      if (signedIn) await mockMsal(page)
      await page.route(`**/api/v1/scans/${mode}`, (route) => route.fulfill({
        json: { scanId: 'test-scan', report: { score: 90, summary: 'Test audit', findings: [] } },
      }))
      await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
      await page.goto('/')
      if (mode === 'repo') await page.getByRole('tab', { name: 'Repository analysis' }).click()
      await page.getByLabel(mode === 'web' ? 'Web page URL' : 'Public GitHub repository URL', { exact: true })
        .fill(mode === 'web' ? 'https://example.com' : 'https://github.com/example/repository')
      const requestPromise = page.waitForRequest(`**/api/v1/scans/${mode}`)
      await page.getByRole('button', { name: 'Analyze', exact: true }).click()
      const request = await requestPromise
      expect(request.headers().authorization).toBe(signedIn ? 'Bearer ' + 'test-api-access-token' : undefined)
      await expect(page.getByRole('heading', { name: 'Your accessibility report' })).toBeVisible()
      await page.getByRole('button', { name: 'Copy Formatted GitHub Issue Markdown' }).click()
      await expect(page.getByRole('status')).toHaveText('Report copied. Paste it into a GitHub issue.')
      const markdown = await page.evaluate(() => navigator.clipboard.readText())
      expect(markdown).toContain(`${new URL(page.url()).origin}/api/v1/scans/test-scan/badge.svg`)
      expect(markdown).not.toContain('/v1/v1/')
      for (const media of [
        { endpoint: 'scans/audio-preview', button: 'Hear screen-reader preview' },
        { endpoint: 'images/accessibility-placeholder', button: 'Generate share card' },
      ]) {
        await page.route(`**/api/v1/${media.endpoint}`, (route) => route.fulfill({
          status: 429,
          json: { error: 'Test media quota response.' },
        }))
        const mediaRequestPromise = page.waitForRequest(`**/api/v1/${media.endpoint}`)
        await page.getByRole('button', { name: media.button, exact: true }).click()
        const mediaRequest = await mediaRequestPromise
        expect(mediaRequest.headers().authorization).toBe(signedIn ? 'Bearer ' + 'test-api-access-token' : undefined)
        await expect(page.getByRole('status')).toHaveText('Test media quota response.')
      }
    })
  }
}

test('signed-in scan does not silently become anonymous when token acquisition fails', async ({ page }) => {
  await mockMsal(page, true)
  let scanRequests = 0
  await page.route('**/api/v1/scans/web', (route) => {
    scanRequests++
    return route.fulfill({ status: 500, json: { error: 'Unexpected scan request' } })
  })
  await page.goto('/')
  await page.getByLabel('Web page URL').fill('https://example.com')
  await page.getByRole('button', { name: 'Analyze', exact: true }).click()
  await expect(page.getByRole('alert')).toHaveText('Test token acquisition failed.')
  expect(scanRequests).toBe(0)
})

test('CSP permits blob audio without allowing blob scripts', () => {
  const config = JSON.parse(readFileSync(new URL('../staticwebapp.config.json', import.meta.url), 'utf8'))
  const directives = config.globalHeaders['Content-Security-Policy'].split(';').map((directive: string) => directive.trim())
  expect(directives).toContain("media-src 'self' blob:")
  expect(directives.filter((directive: string) => directive.includes('blob:'))).toEqual(["media-src 'self' blob:"])
})
