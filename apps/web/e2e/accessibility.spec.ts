import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'

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
