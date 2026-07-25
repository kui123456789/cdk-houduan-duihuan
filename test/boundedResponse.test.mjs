import assert from "node:assert/strict";
import test from "node:test";

import {
  ResponseBodyTooLargeError,
  readTextWithLimit
} from "../src/domain/boundedResponse.js";

function streamResponse(chunks, { headers = {}, onCancel } = {}) {
  return new Response(
    new ReadableStream({
      start(controller) {
        chunks.forEach((chunk) => controller.enqueue(chunk));
        controller.close();
      },
      cancel(reason) {
        onCancel?.(reason);
      }
    }),
    { headers }
  );
}

test("readTextWithLimit decodes UTF-8 split across chunks", async () => {
  const bytes = new TextEncoder().encode("alpha-兑换");
  const response = streamResponse([bytes.slice(0, 8), bytes.slice(8, 10), bytes.slice(10)]);

  assert.equal(await readTextWithLimit(response, { maxBytes: bytes.byteLength }), "alpha-兑换");
});

test("readTextWithLimit rejects declared oversized bodies before reading them", async () => {
  let cancelled = false;
  const response = streamResponse([new TextEncoder().encode("small")], {
    headers: { "Content-Length": "101" },
    onCancel: () => {
      cancelled = true;
    }
  });

  await assert.rejects(
    readTextWithLimit(response, { maxBytes: 100 }),
    (error) => error instanceof ResponseBodyTooLargeError && error.maxBytes === 100
  );
  assert.equal(cancelled, true);
});

test("readTextWithLimit cancels chunked bodies as soon as the byte limit is exceeded", async () => {
  let cancelled = false;
  const response = streamResponse(
    [new Uint8Array(60), new Uint8Array(41), new Uint8Array(500_000)],
    {
      onCancel: () => {
        cancelled = true;
      }
    }
  );
  const abortController = new AbortController();

  await assert.rejects(
    readTextWithLimit(response, { maxBytes: 100, abortController }),
    (error) => error instanceof ResponseBodyTooLargeError
  );
  assert.equal(cancelled, true);
  assert.equal(abortController.signal.aborted, true);
});

test("readTextWithLimit aborts and cancels a slow response body", async () => {
  let cancelled = false;
  const response = new Response(
    new ReadableStream({
      pull() {
        return new Promise(() => {});
      },
      cancel() {
        cancelled = true;
      }
    })
  );
  const abortController = new AbortController();
  setTimeout(() => abortController.abort(), 10);

  await assert.rejects(
    readTextWithLimit(response, {
      maxBytes: 100,
      signal: abortController.signal
    }),
    (error) => error?.name === "AbortError"
  );
  assert.equal(cancelled, true);
});
