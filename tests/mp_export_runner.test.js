const assert = require("assert");

// mp_export_runner.js exports a small __test__ surface in Node.
const R = require("../mp_export_runner.js");

function testTransientHttpStatus() {
  assert.strictEqual(R.__test__.isTransientHttpStatus(429), true);
  assert.strictEqual(R.__test__.isTransientHttpStatus(503), true);
  assert.strictEqual(R.__test__.isTransientHttpStatus(403), true);
  assert.strictEqual(R.__test__.isTransientHttpStatus(408), true);
  assert.strictEqual(R.__test__.isTransientHttpStatus(400), false);
  assert.strictEqual(R.__test__.isTransientHttpStatus(401), false);
  assert.strictEqual(R.__test__.isTransientHttpStatus(404), false);
}

function testTransientErrorCodes() {
  assert.strictEqual(R.__test__.isTransientErrorCode("HTTP_429"), true);
  assert.strictEqual(R.__test__.isTransientErrorCode("HTTP_503"), true);
  assert.strictEqual(R.__test__.isTransientErrorCode("HTTP_403"), true);
  assert.strictEqual(R.__test__.isTransientErrorCode("BAD_RESPONSE"), true);
  assert.strictEqual(R.__test__.isTransientErrorCode("NO_RESPONSE"), true);
  assert.strictEqual(R.__test__.isTransientErrorCode("NETWORK_ERROR"), true);
  assert.strictEqual(R.__test__.isTransientErrorCode("TIMEOUT"), true);
  assert.strictEqual(R.__test__.isTransientErrorCode("HTTP_401"), false);
  assert.strictEqual(R.__test__.isTransientErrorCode("NOT_LOGGED_IN"), false);
}

function testBuildPartialPayloadPreservesItemsAndPage() {
  const payload = R.__test__.buildPartialPayload({
    status: "paused",
    page: 12,
    pages: 99,
    total: 1234,
    userId: "42",
    items: [{ comic_id: "a" }, { comic_id: "b" }],
  });

  assert.strictEqual(payload.meta.status, "paused");
  assert.strictEqual(payload.meta.page, 12);
  assert.strictEqual(payload.meta.pages, 99);
  assert.strictEqual(payload.meta.total, 1234);
  assert.strictEqual(payload.meta.userId, "42");
  assert.ok(typeof payload.meta.updated_at === "string");
  assert.ok(Array.isArray(payload.items));
  assert.strictEqual(payload.items.length, 2);
}

function testPauseBackoffRange() {
  for (let i = 0; i < 50; i += 1) {
    const ms = R.__test__.computePauseBackoffMs();
    assert.ok(ms >= 5000 && ms <= 15000, `backoff out of range: ${ms}`);
  }
}

function testClassifyNetworkFailure() {
  // fetch rejected
  assert.deepStrictEqual(
    R.__test__.classifyNetworkFailure({ res: null, jsonOk: null, err: new Error("x") }),
    { retryable: true, code: "NETWORK_ERROR" }
  );
  // timeout abort
  const ae = new Error("abort");
  ae.name = "AbortError";
  assert.deepStrictEqual(
    R.__test__.classifyNetworkFailure({ res: null, jsonOk: null, err: ae }),
    { retryable: true, code: "TIMEOUT" }
  );
  // http 429 retryable
  assert.deepStrictEqual(
    R.__test__.classifyNetworkFailure({ res: { ok: false, status: 429 }, jsonOk: null, err: null }),
    { retryable: true, code: "HTTP_429" }
  );
  // http 401 fatal
  assert.deepStrictEqual(
    R.__test__.classifyNetworkFailure({ res: { ok: false, status: 401 }, jsonOk: null, err: null }),
    { retryable: false, code: "HTTP_401" }
  );
  // ok but invalid json shape => retryable BAD_RESPONSE
  assert.deepStrictEqual(
    R.__test__.classifyNetworkFailure({ res: { ok: true, status: 200 }, jsonOk: false, err: null }),
    { retryable: true, code: "BAD_RESPONSE" }
  );
  // ok and json ok => no failure
  assert.deepStrictEqual(
    R.__test__.classifyNetworkFailure({ res: { ok: true, status: 200 }, jsonOk: true, err: null }),
    { retryable: false, code: "" }
  );
}

function run() {
  assert.ok(R && R.__test__, "mp_export_runner.js must expose __test__ in Node");
  testTransientHttpStatus();
  testTransientErrorCodes();
  testBuildPartialPayloadPreservesItemsAndPage();
  testPauseBackoffRange();
  testClassifyNetworkFailure();
  console.log("mp_export_runner.test.js OK");
}

run();

