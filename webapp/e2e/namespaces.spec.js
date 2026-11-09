import { expect, test } from '@playwright/test'

test('first-run setup and namespace management page load', async ({ page }) => {
  await page.goto('/')
  await page.getByPlaceholder('邮箱').fill('admin@example.com')
  await page.getByPlaceholder('密码（至少 8 位）').fill('correct horse battery')
  await page.getByPlaceholder('再输入一次密码').fill('correct horse battery')
  await page.getByRole('button', { name: '创建并进入' }).click()

  await expect(page.getByText('记忆空间', { exact: true }).first()).toBeVisible()
  await page.getByText('记忆空间', { exact: true }).first().click()
  await expect(page.getByText('命名空间', { exact: true }).first()).toBeVisible()

  await page.getByPlaceholder('新空间名称').fill('e2e-project')
  await page.getByRole('button', { name: '新建', exact: true }).click()
  await page.getByRole('button', { name: '创建', exact: true }).click()
  await expect(page.getByText('e2e-project', { exact: true }).first()).toBeVisible()

  await page.getByText('捕获审阅', { exact: true }).first().click()
  await expect(page.getByText('没有待审阅的捕获')).toBeVisible()
})
