import { expect, test } from "@playwright/test";

function watchRuntimeErrors(page) {
  const errors = [];
  page.on("console", (message) => {
    if (
      message.type() === "error" ||
      /unique "key" prop|duplicate key/i.test(message.text())
    ) {
      errors.push(`console.${message.type()}: ${message.text()}`);
    }
  });
  page.on("pageerror", (error) => {
    errors.push(`pageerror: ${error.message}`);
  });
  return errors;
}

async function mockApi(page, { onStatusRequest = () => {} } = {}) {
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());

    if (url.pathname === "/api/redeem/status") {
      onStatusRequest(request);
      const body = request.postDataJSON();
      const cdkeys = Array.isArray(body?.cdkeys) ? body.cdkeys : [];
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          items: cdkeys.map((cdkey) => ({
            cdkey,
            status: "success",
            reason: "E2E mock",
          })),
        }),
      });
      return;
    }

    if (url.pathname === "/api/local/session-cookie") {
      await route.fulfill({ json: { ok: true, configured: false } });
      return;
    }

    if (url.pathname === "/api/redeem/tasks/queue-summary") {
      await route.fulfill({
        json: { ok: true, total: 0, queued: 0, running: 0 },
      });
      return;
    }

    if (url.pathname === "/api/redeem/tasks") {
      await route.fulfill({
        json: { ok: true, items: [], data: { items: [], total: 0 } },
      });
      return;
    }

    await route.fulfill({ json: { ok: true, items: [], data: { items: [] } } });
  });
}

test("renders the workspace and switches between all primary tabs", async ({
  page,
}) => {
  const runtimeErrors = watchRuntimeErrors(page);
  await mockApi(page);

  await page.goto("/");

  await expect(
    page.getByRole("heading", { name: "CDK 后端兑换控制台" }),
  ).toBeVisible();
  const tabs = page.getByRole("tab");
  await expect(tabs).toHaveCount(4);

  for (const name of ["账号检测", "执行监控", "结果导出", "准备输入"]) {
    const tab = page.getByRole("tab", { name: new RegExp(`^${name}`) });
    await tab.click();
    await expect(tab).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("tabpanel")).toBeVisible();
  }

  expect(runtimeErrors, runtimeErrors.join("\n")).toEqual([]);
});

test("queries a persisted task status only once during StrictMode startup", async ({
  page,
}) => {
  const runtimeErrors = watchRuntimeErrors(page);
  let statusRequestCount = 0;
  await mockApi(page, {
    onStatusRequest: () => {
      statusRequestCount += 1;
    },
  });
  await page.addInitScript(() => {
    localStorage.setItem(
      "cdkRedeem.workflowSnapshot.v1",
      JSON.stringify({
        version: 1,
        savedAt: Date.now(),
        rows: [
          {
            id: "persisted-row",
            rowKind: "redeem",
            queryOnly: false,
            email: "persisted@example.com",
            cdkey: "E2E-PERSISTED-CDK",
            status: "pending_dispatch",
            statusOwner: true,
            selected: false,
          },
        ],
        accountLedger: {},
        accountCooldowns: {},
        autoCycleState: {},
        deletedTaskKeys: {},
        failedAccounts: [],
        plusExports: {},
        downloadedExportCounts: {},
        activityLog: [],
        ui: { activeWorkspaceTab: "execute", pollingEnabled: false },
      }),
    );
  });

  await page.goto("/");
  await expect(page.getByRole("tab", { name: /^执行监控/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect.poll(() => statusRequestCount).toBe(1);
  await page.waitForTimeout(500);

  expect(statusRequestCount).toBe(1);
  expect(runtimeErrors, runtimeErrors.join("\n")).toEqual([]);
});

test("keeps a repeated query result after the same row was deleted", async ({ page }) => {
  const runtimeErrors = watchRuntimeErrors(page);
  await mockApi(page);

  await page.goto("/");
  await page.getByRole("tab", { name: /^准备输入/ }).click();
  const cdkInput = page.locator("section.pool-card.kakao textarea");
  await cdkInput.fill("E2E-REPEATED-QUERY-CDK");

  await page.getByRole("tab", { name: /^执行监控/ }).click();
  await page.getByRole("button", { name: "查询状态" }).click();
  await expect(page.getByText(/查询完成：1 个 CDK/).first()).toBeVisible();
  const resultRow = page.locator("tbody tr", { hasText: "E2E-REPEATED-QUERY-CDK" });
  await expect(resultRow).toHaveCount(1);

  await resultRow.getByTitle("删除该请求").click();
  await expect(resultRow).toHaveCount(0);

  await page.getByRole("tab", { name: /^准备输入/ }).click();
  await cdkInput.fill("E2E-REPEATED-QUERY-CDK");
  await page.getByRole("tab", { name: /^执行监控/ }).click();
  await page.getByRole("button", { name: "查询状态" }).click();

  await expect(page.getByText(/查询完成：1 个 CDK/).first()).toBeVisible();
  await expect(resultRow).toHaveCount(1);
  await page.waitForTimeout(300);
  await expect(resultRow).toHaveCount(1);
  expect(runtimeErrors, runtimeErrors.join("\n")).toEqual([]);
});
