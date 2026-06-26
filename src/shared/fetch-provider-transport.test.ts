import assert from "node:assert/strict";
import test from "node:test";

import {
  FetchProviderTransport,
  type FetchProviderRequestInit,
  type FetchProviderResponse
} from "./fetch-provider-transport.js";

class TestHeaders {
  constructor(private readonly entries: Readonly<Record<string, string>>) {}

  forEach(callback: (value: string, key: string) => void): void {
    for (const [key, value] of Object.entries(this.entries)) {
      callback(value, key);
    }
  }
}

function response(
  body: string,
  options: {
    readonly status?: number;
    readonly headers?: Readonly<Record<string, string>>;
  } = {}
): FetchProviderResponse {
  return {
    status: options.status ?? 200,
    headers: new TestHeaders(options.headers ?? {}),
    text: async () => body
  };
}

test("fetch provider transport sends JSON requests and parses JSON responses", async () => {
  let requestUrl = "";
  let requestInit: FetchProviderRequestInit | undefined;
  let now = 100;
  const transport = new FetchProviderTransport({
    nowMs: () => now,
    fetch: async (url, init) => {
      requestUrl = url;
      requestInit = init;
      now = 137;
      return response(JSON.stringify({ answer: "ok" }), {
        headers: { "content-type": "application/json" }
      });
    }
  });

  const result = await transport.send({
    requestId: "request_1",
    url: "https://provider.example.test/v1/chat",
    method: "POST",
    headers: {
      authorization: "provider-token",
      "content-type": "application/json"
    },
    body: { question: "refund policy" },
    timeoutMs: 5000
  });

  assert.equal(requestUrl, "https://provider.example.test/v1/chat");
  assert.deepEqual(JSON.parse(requestInit?.body ?? ""), {
    question: "refund policy"
  });
  assert.equal(requestInit?.method, "POST");
  assert.equal(requestInit?.headers["authorization"], "provider-token");
  assert.deepEqual(result.body, { answer: "ok" });
  assert.equal(result.headers["content-type"], "application/json");
  assert.equal(result.latencyMs, 37);
});

test("fetch provider transport returns text bodies when response is not JSON", async () => {
  const transport = new FetchProviderTransport({
    fetch: async () => response("temporary outage", { status: 503 })
  });

  const result = await transport.send({
    requestId: "request_2",
    url: "https://provider.example.test/v1/chat",
    method: "POST",
    headers: {},
    body: { question: "refund policy" },
    timeoutMs: 5000
  });

  assert.equal(result.status, 503);
  assert.equal(result.body, "temporary outage");
});

test("fetch provider transport converts aborts into timeout errors", async () => {
  const transport = new FetchProviderTransport({
    fetch: async (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => {
          reject(new Error("aborted"));
        });
      })
  });

  await assert.rejects(
    () =>
      transport.send({
        requestId: "request_3",
        url: "https://provider.example.test/v1/chat",
        method: "POST",
        headers: {},
        body: { question: "refund policy" },
        timeoutMs: 1
      }),
    /timeout after 1 ms/
  );
});
