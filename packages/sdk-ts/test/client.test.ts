import assert from "node:assert/strict";
import { test } from "node:test";

import {
  LodzApiError,
  LodzClient,
  LodzDeniedAssetError,
  LodzNetworkError,
  LodzResponseError,
  LodzTimeoutError,
  LodzUsageError,
} from "../src/index.js";
import type { FetchLike } from "../src/index.js";

const API = "http://indexer.test";

/** A fetch stub. Records calls so a test can assert the wire request. */
function stub(
  handler: (url: string, init?: Parameters<FetchLike>[1]) => { status: number; body: string },
): { fetch: FetchLike; calls: { url: string; method?: string; body?: string }[] } {
  const calls: { url: string; method?: string; body?: string }[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, method: init?.method, body: init?.body });
    const { status, body } = handler(url, init);
    return { ok: status >= 200 && status < 300, status, text: async () => body };
  };
  return { fetch, calls };
}

const okSeams = JSON.stringify({
  seams: [
    { id: "a", yield_type: "sustainable", display_apy_bps: 1547 },
    { id: "b", yield_type: "counterparty", display_apy_bps: 21482 },
  ],
  stope: "balanced",
  totals: { seam_count: 2, emissions_count: 0 },
  allocation_notes: [],
  excluded_candidates: [],
  usd_reference: { btc_usd: 100000, source: "operator", live: false },
  provenance: { source: "defillama", live: true },
});

test("constructor rejects a missing or non-http apiUrl", () => {
  assert.throws(() => new LodzClient({ apiUrl: "" }), LodzUsageError);
  assert.throws(() => new LodzClient({ apiUrl: "indexer.test" }), LodzUsageError);
});

test("constructor strips trailing slashes so paths do not double up", () => {
  const c = new LodzClient({ apiUrl: `${API}///`, fetch: stub(() => ({ status: 200, body: "{}" })).fetch });
  assert.equal(c.apiUrl, API);
});

test("seams.list returns the parsed body and calls the right path", async () => {
  const s = stub(() => ({ status: 200, body: okSeams }));
  const c = new LodzClient({ apiUrl: API, fetch: s.fetch });
  const res = await c.seams.list();
  assert.equal(res.seams.length, 2);
  assert.equal(s.calls[0]?.url, `${API}/seams`);
});

test("seams.list filters by yield type without rewriting the totals", async () => {
  const c = new LodzClient({ apiUrl: API, fetch: stub(() => ({ status: 200, body: okSeams })).fetch });
  const res = await c.seams.list({ type: "counterparty" });
  assert.equal(res.seams.length, 1);
  assert.equal(res.seams[0]?.id, "b");
  // The catalogue-wide totals must survive the filter: a filtered view whose
  // totals moved with it would hide that emissions_count is zero everywhere.
  assert.equal(res.totals.seam_count, 2);
  assert.equal(res.totals["emissions_count"], 0);
});

test("seams.list rejects an unknown yield type before any request", async () => {
  const s = stub(() => ({ status: 200, body: okSeams }));
  const c = new LodzClient({ apiUrl: API, fetch: s.fetch });
  await assert.rejects(
    () => c.seams.list({ type: "sustainble" as never }),
    (e: unknown) => e instanceof LodzUsageError,
  );
  assert.equal(s.calls.length, 0);
});

test("assay.estimate posts snake_case and rejects a non-positive amount", async () => {
  const s = stub(() => ({ status: 200, body: JSON.stringify({ btc_amount: 1.5 }) }));
  const c = new LodzClient({ apiUrl: API, fetch: s.fetch });
  await c.assay.estimate({ btcAmount: 1.5, stope: "aggressive" });
  assert.equal(s.calls[0]?.method, "POST");
  assert.deepEqual(JSON.parse(s.calls[0]?.body ?? "{}"), {
    btc_amount: 1.5,
    stope: "aggressive",
  });
  await assert.rejects(() => c.assay.estimate({ btcAmount: 0 }), LodzUsageError);
  await assert.rejects(() => c.assay.estimate({ btcAmount: Number.NaN }), LodzUsageError);
});

test("assay.estimate rejects an unknown stope before any request", async () => {
  const s = stub(() => ({ status: 200, body: "{}" }));
  const c = new LodzClient({ apiUrl: API, fetch: s.fetch });
  await assert.rejects(
    () => c.assay.estimate({ btcAmount: 1, stope: "reckless" as never }),
    LodzUsageError,
  );
  assert.equal(s.calls.length, 0);
});

test("a non-2xx response throws LodzApiError carrying code, detail and request id", async () => {
  const body = JSON.stringify({
    error: {
      code: "validation_error",
      message: "Request did not match the schema.",
      detail: "body.btc_amount: Input should be greater than 0",
    },
    path: "/assay",
    request_id: "lodz-000061",
  });
  const c = new LodzClient({ apiUrl: API, fetch: stub(() => ({ status: 422, body })).fetch });
  await assert.rejects(
    () => c.metrics.header(),
    (e: unknown) => {
      assert.ok(e instanceof LodzApiError);
      assert.equal(e.status, 422);
      assert.equal(e.code, "validation_error");
      assert.equal(e.requestId, "lodz-000061");
      assert.match(e.message, /greater than 0/);
      return true;
    },
  );
});

test("an error response never becomes an empty success value", async () => {
  const c = new LodzClient({ apiUrl: API, fetch: stub(() => ({ status: 500, body: "boom" })).fetch });
  // The failure mode this guards: returning { seams: [] } on a 500, which a
  // dashboard renders as "no seams" rather than "service down".
  await assert.rejects(() => c.seams.list(), LodzApiError);
});

test("a non-JSON 200 throws LodzResponseError rather than yielding undefined", async () => {
  const c = new LodzClient({
    apiUrl: API,
    fetch: stub(() => ({ status: 200, body: "<html>gateway</html>" })).fetch,
  });
  await assert.rejects(() => c.metrics.header(), LodzResponseError);
});

test("a transport failure throws LodzNetworkError with the cause attached", async () => {
  const boom = new Error("ECONNREFUSED");
  const fetch: FetchLike = async () => {
    throw boom;
  };
  const c = new LodzClient({ apiUrl: API, fetch });
  await assert.rejects(
    () => c.metrics.header(),
    (e: unknown) => e instanceof LodzNetworkError && (e as LodzNetworkError).cause === boom,
  );
});

test("a slow response throws LodzTimeoutError", async () => {
  const fetch: FetchLike = (_url, init) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        const e = new Error("aborted");
        e.name = "AbortError";
        reject(e);
      });
    });
  const c = new LodzClient({ apiUrl: API, fetch, timeoutMs: 20 });
  await assert.rejects(() => c.metrics.header(), LodzTimeoutError);
});

test("a caller AbortSignal cancels the request", async () => {
  const fetch: FetchLike = (_url, init) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        const e = new Error("aborted");
        e.name = "AbortError";
        reject(e);
      });
    });
  const c = new LodzClient({ apiUrl: API, fetch, timeoutMs: 60_000 });
  const ac = new AbortController();
  const p = c.metrics.header({ signal: ac.signal });
  ac.abort();
  await assert.rejects(() => p, LodzTimeoutError);
});

test("orecart.queue encodes owner and stope into the query", async () => {
  const s = stub(() => ({ status: 200, body: "{}" }));
  const c = new LodzClient({ apiUrl: API, fetch: s.fetch });
  await c.orecart.queue({ owner: "So11111111111111111111111111111111111111112", stope: "conservative" });
  assert.match(s.calls[0]?.url ?? "", /owner=So111/);
  assert.match(s.calls[0]?.url ?? "", /stope=conservative/);
});

test("the client rejects denylisted mints", () => {
  const c = new LodzClient({ apiUrl: API, fetch: stub(() => ({ status: 200, body: "{}" })).fetch });
  assert.throws(
    () => c.assertRoutableMint("9n4nbM75f5Ui33ZbPYXn59EwSgE8CGsHtAeTH5YFeJ9E"),
    LodzDeniedAssetError,
  );
});
