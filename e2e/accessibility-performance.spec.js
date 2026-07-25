import { expect, test } from "@playwright/test";

test("dialog traps keyboard focus and restores the trigger", async ({ page }) => {
  await page.goto("/");

  const trigger = page.getByRole("button", { name: "导入卡密" });
  await trigger.click();

  const dialog = page.getByRole("dialog", { name: "导入卡密" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("textbox")).toBeFocused();

  await dialog.getByRole("button", { name: "确认追加" }).focus();
  await page.keyboard.press("Tab");
  await expect(dialog.getByRole("button", { name: "IDEAL VIP" })).toBeFocused();

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
});

test("1000 task rows render in bounded pages on desktop and mobile", async ({ page }) => {
  await page.addInitScript(() => {
    const rows = Array.from({ length: 1000 }, (_, index) => ({
      id: `row-${index}`,
      cdkey: `CDK-${String(index).padStart(4, "0")}`,
      status: "unknown",
      selected: false,
      displayIndex: index + 1,
      cdkeyLineNumber: index + 1
    }));
    localStorage.setItem(
      "cdkRedeem.workflowSnapshot.v1",
      JSON.stringify({
        version: 1,
        savedAt: Date.now(),
        rows,
        ui: { activeWorkspaceTab: "execute" }
      })
    );
  });

  await page.goto("/");
  const panel = page.locator(".request-panel");
  await expect(panel.locator("tbody tr")).toHaveCount(50);
  await expect(panel.locator(".pagination-range")).toHaveText("1-50 / 1000");
  await expect(panel.locator(".pagination-page")).toHaveText("第 1 / 20 页");

  await panel.getByRole("button", { name: "下一页请求状态" }).click();
  await expect(panel.locator("tbody tr")).toHaveCount(50);
  await expect(panel.locator(".pagination-range")).toHaveText("51-100 / 1000");
  await expect(panel.locator("tbody tr").first()).toContainText("CDK-0050");

  await page.setViewportSize({ width: 390, height: 844 });
  await panel.scrollIntoViewIfNeeded();
  await expect(panel.getByRole("button", { name: "下一页请求状态" })).toBeVisible();
});

test("job mode restores by Job ID and synchronizes status across tabs without stored credentials", async ({ context, page }) => {
  let itemStatus = "running";
  await context.addInitScript(() => {
    localStorage.setItem("cdkRedeem.jobModeEnabled", "true");
    localStorage.setItem("cdkRedeem.jobIds.v1", JSON.stringify(["job-e2e"]));
    localStorage.setItem(
      "cdkRedeem.uiSettings",
      JSON.stringify({ activeWorkspaceTab: "execute" })
    );
    localStorage.setItem("cdkRedeem.apiKey", "must-be-cleared");
    localStorage.setItem("cdkRedeem.workflowSnapshot.v1", JSON.stringify({ accessToken: "must-be-cleared" }));
  });
  await context.route("**/api/auth/me", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        user: { id: "user-e2e", username: "operator-e2e", role: "operator" },
        csrfToken: "csrf-e2e"
      })
    });
  });
  await context.route("**/api/jobs/job-e2e", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        job: {
          id: "job-e2e",
          status: itemStatus === "success" ? "completed" : "running",
          items: [{
            id: "item-e2e",
            cdkey: "CDK-JOB-E2E",
            channel: "upi",
            status: itemStatus === "success" ? "succeeded" : "running",
            result: itemStatus === "success" ? { status: "success" } : {}
          }]
        }
      })
    });
  });

  await page.goto("/");
  const firstPanel = page.locator(".request-panel");
  await expect(firstPanel).toContainText("CDK-JOB-E2E");
  await expect(firstPanel).toContainText("兑换中");

  const secondPage = await context.newPage();
  await secondPage.goto("/");
  const secondPanel = secondPage.locator(".request-panel");
  await expect(secondPanel).toContainText("兑换中");

  itemStatus = "success";
  await page.evaluate(() => {
    localStorage.setItem("cdkRedeem.jobIds.v1", JSON.stringify(["job-e2e", "job-e2e"]));
  });
  await expect(secondPanel).toContainText("兑换成功");

  await page.reload();
  await expect(firstPanel).toContainText("兑换成功");
  const stored = await page.evaluate(() => Object.values(localStorage).join("\n"));
  expect(stored).not.toContain("must-be-cleared");
  expect(stored).not.toContain("accessToken");
});

test("job mode gates the workspace behind login without persisting session material", async ({ context, page }) => {
  await context.addInitScript(() => {
    localStorage.setItem("cdkRedeem.jobModeEnabled", "true");
  });
  await context.route("**/api/auth/me", async (route) => {
    await route.fulfill({
      status: 401,
      contentType: "application/json",
      body: JSON.stringify({ code: "AUTHENTICATION_REQUIRED", message: "需要登录" })
    });
  });
  await context.route("**/api/auth/login", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        user: { id: "user-login-e2e", username: "operator-e2e", role: "operator" },
        csrfToken: "csrf-login-e2e"
      })
    });
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "CDK 后端兑换控制台" })).toBeVisible();
  await page.getByLabel("用户名").fill("operator-e2e");
  await page.getByLabel("密码").fill("not-a-real-password");
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page.locator(".pipeline-layout")).toBeVisible();
  await expect(page.getByText("operator-e2e · operator")).toBeVisible();

  const stored = await page.evaluate(() => Object.values(localStorage).join("\n"));
  expect(stored).not.toContain("csrf-login-e2e");
  expect(stored).not.toContain("not-a-real-password");
});
