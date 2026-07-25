import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../server/app.js";
import { handleRequest } from "../worker/index.js";

async function withServer(app, callback) {
  const server = app.listen(0, "127.0.0.1");
  try {
    await new Promise((resolve) => server.once("listening", resolve));
    const { port } = server.address();
    await callback(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

function assertUtf8Download(response, expectedContent) {
  const disposition = response.headers.get("content-disposition") || "";
  const fallback = disposition.match(/filename="([^"]+)"/)?.[1] || "";

  assert.equal(response.status, 200);
  assert.match(disposition, /filename="[\x20-\x7e]+"/);
  assert.doesNotMatch(fallback, /[^\x20-\x7e]/);
  assert.match(disposition, /filename\*=UTF-8''%E5%AF%BC%E5%87%BA%E7%BB%93%E6%9E%9C\.txt/);
  return response.text().then((content) => assert.equal(content, expectedContent));
}

test("Express returns Chinese download names with an ASCII fallback", async () => {
  await withServer(createApp({ config: { nodeEnv: "test" } }), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/download/text`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fileName: "导出结果", content: "alpha\nbeta" })
    });

    await assertUtf8Download(response, "alpha\nbeta");
  });
});

test("Worker returns Chinese download names with an ASCII fallback", async () => {
  const response = await handleRequest(
    new Request("https://example.test/api/download/text", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fileName: "导出结果", content: "alpha\nbeta" })
    }),
    {},
    fetch
  );

  await assertUtf8Download(response, "alpha\nbeta");
});
