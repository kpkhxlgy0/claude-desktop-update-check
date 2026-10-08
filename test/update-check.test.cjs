const assert = require("node:assert/strict");
const test = require("node:test");
const { checkClaudeDesktopUpdate } = require("../update-check.cjs");

const baseOptions = {
  currentVersion: "2.26454.1.0",
  deviceId: "93d6dd7c-2c79-4f6b-98b6-a9102c4dbe13",
  arch: "x64",
  osVersion: "10.0.26100",
};

test("queries only update metadata with the supplied rollout identifier", async () => {
  const calls = [];
  const result = await checkClaudeDesktopUpdate({
    ...baseOptions,
    request: async (input, init) => {
      calls.push({ input, init });
      return jsonResponse(feed("2.26454.2", "A newer release"));
    },
  });

  assert.deepEqual(result, {
    currentVersion: "2.26454.1.0",
    latestVersion: "2.26454.2",
    updateAvailable: true,
    releaseNotes: "A newer release",
  });
  assert.equal(calls.length, 1, "must not request updateTo.url");
  const url = new URL(calls[0].input);
  assert.equal(url.origin, "https://api.anthropic.com");
  assert.equal(url.pathname, "/api/desktop/win32/x64/msix/update");
  assert.deepEqual([...url.searchParams.entries()].sort(), [
    ["device_id", baseOptions.deviceId],
    ["os_version", "10.0.26100"],
    ["version", "2.26454.1.0"],
  ]);
  assert.equal(calls[0].init.method, "GET");
  assert.equal(calls[0].init.redirect, "error");
  assert.equal(calls[0].init.credentials, "omit");
  assert.equal(new Headers(calls[0].init.headers).get("accept"), "application/json");
  assert.equal(new Headers(calls[0].init.headers).get("authorization"), null);
  assert.ok(calls[0].init.signal instanceof AbortSignal);
});

test("uses the arm64 metadata endpoint", async () => {
  let requestedUrl;
  await checkClaudeDesktopUpdate({
    ...baseOptions,
    arch: "arm64",
    request: async (input) => {
      requestedUrl = new URL(input);
      return new Response(null, { status: 204 });
    },
  });
  assert.equal(requestedUrl.pathname, "/api/desktop/win32/arm64/msix/update");
});

for (const { currentVersion, latestVersion, normalizedVersion, expected } of [
  { currentVersion: "2.26454.2.0", latestVersion: "2.26454.2", normalizedVersion: "2.26454.2", expected: false },
  { currentVersion: "2.26454.2", latestVersion: "2.26454.2.0", normalizedVersion: "2.26454.2", expected: false },
  { currentVersion: "2.9.99.0", latestVersion: "2.10.0", normalizedVersion: "2.10.0", expected: true },
  { currentVersion: "2.26454.3.0", latestVersion: "2.26454.2", normalizedVersion: "2.26454.2", expected: false },
  { currentVersion: "2.26454.2.1", latestVersion: "2.26454.2", normalizedVersion: "2.26454.2", expected: false },
  { currentVersion: "2.26454.2.0", latestVersion: "2.26454.2.1", normalizedVersion: "2.26454.2.1", expected: true },
]) {
  test(`compares ${latestVersion} against installed ${currentVersion} numerically`, async () => {
    const result = await checkClaudeDesktopUpdate({
      ...baseOptions,
      currentVersion,
      request: async () => jsonResponse(feed(latestVersion)),
    });
    assert.equal(result.updateAvailable, expected);
    assert.equal(result.currentVersion, currentVersion);
    assert.equal(result.latestVersion, normalizedVersion);
  });
}

test("uses currentRelease rather than an unrelated newer release in the feed", async () => {
  const result = await checkClaudeDesktopUpdate({
    ...baseOptions,
    request: async () => jsonResponse({
      currentRelease: "2.26454.2",
      releases: [
        ...feed("2.26454.9", "Different rollout").releases,
        ...feed("2.26454.2", "Selected rollout").releases,
      ],
    }),
  });
  assert.equal(result.latestVersion, "2.26454.2");
  assert.equal(result.releaseNotes, "Selected rollout");
});

test("accepts the native version fallback when currentRelease is absent", async () => {
  const result = await checkClaudeDesktopUpdate({
    ...baseOptions,
    request: async () => jsonResponse({ version: "2.26454.2" }),
  });
  assert.deepEqual(result, {
    currentVersion: "2.26454.1.0",
    latestVersion: "2.26454.2",
    updateAvailable: true,
    releaseNotes: null,
  });
});

test("does not display notes belonging to a different version", async () => {
  const result = await checkClaudeDesktopUpdate({
    ...baseOptions,
    request: async () => jsonResponse({
      currentRelease: "2.26454.2",
      releases: feed("2.26454.9", "Different rollout").releases,
    }),
  });
  assert.equal(result.releaseNotes, null);
});

for (const status of [204, 404]) {
  test(`treats HTTP ${status} as no available release`, async () => {
    const result = await checkClaudeDesktopUpdate({
      ...baseOptions,
      request: async () => new Response(null, { status }),
    });
    assert.deepEqual(result, {
      currentVersion: "2.26454.1.0",
      latestVersion: null,
      updateAvailable: false,
      releaseNotes: null,
    });
  });
}

for (const status of [400, 403, 429, 500]) {
  test(`rejects HTTP ${status} instead of reporting an up-to-date result`, async () => {
    await assert.rejects(checkClaudeDesktopUpdate({
      ...baseOptions,
      request: async () => jsonResponse({ error: "unavailable" }, status),
    }), new RegExp(String(status)));
  });
}

test("rejects redirects without requesting the destination", async () => {
  let requests = 0;
  await assert.rejects(checkClaudeDesktopUpdate({
    ...baseOptions,
    request: async () => {
      requests += 1;
      return new Response(null, { status: 302, headers: { location: "https://example.invalid/app.msix" } });
    },
  }), /redirect/i);
  assert.equal(requests, 1);
});

test("rejects a response already redirected by an incompatible request adapter", async () => {
  const response = jsonResponse(feed("2.26454.2"));
  Object.defineProperty(response, "redirected", { value: true });
  await assert.rejects(checkClaudeDesktopUpdate({
    ...baseOptions,
    request: async () => response,
  }), /redirect/i);
});

test("rejects binary metadata responses before consuming their body", async () => {
  let read = false;
  const response = new Response(new ReadableStream({
    pull() { read = true; },
  }, { highWaterMark: 0 }), { headers: { "content-type": "application/octet-stream" } });
  await assert.rejects(checkClaudeDesktopUpdate({
    ...baseOptions,
    request: async () => response,
  }), /content.type|JSON/i);
  assert.equal(read, false);
});

test("rejects malformed JSON", async () => {
  await assert.rejects(checkClaudeDesktopUpdate({
    ...baseOptions,
    request: async () => new Response("{broken", { headers: { "content-type": "application/json" } }),
  }), /JSON/i);
});

for (const body of [
  [],
  null,
  {},
  { currentRelease: 2 },
  { currentRelease: "2.26454.2-beta" },
  { currentRelease: "2.26454.2", releases: {} },
  { currentRelease: "2.26454.2", releases: [null] },
  { currentRelease: "2.26454.2", releases: [{ version: "bad" }] },
  { currentRelease: "2.26454.2", releases: [{ version: "2.26454.2", updateTo: "installer" }] },
  { currentRelease: "2.26454.2", releases: [{ version: "2.26454.2", updateTo: { version: "2.26454.2", notes: {} } }] },
]) {
  test(`rejects invalid metadata schema ${JSON.stringify(body)}`, async () => {
    await assert.rejects(checkClaudeDesktopUpdate({
      ...baseOptions,
      request: async () => jsonResponse(body),
    }), /metadata|version/i);
  });
}

test("rejects an oversized declared metadata body", async () => {
  await assert.rejects(checkClaudeDesktopUpdate({
    ...baseOptions,
    request: async () => jsonResponse(feed("2.26454.2"), 200, { "content-length": "1048576" }),
  }), /large|size|limit/i);
});

test("limits streamed metadata bytes and cancels the remaining body", async () => {
  let cancelled = false;
  const body = new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(1048576)); },
    cancel() { cancelled = true; },
  });
  await assert.rejects(checkClaudeDesktopUpdate({
    ...baseOptions,
    request: async () => new Response(body, { headers: { "content-type": "application/json" } }),
  }), /large|size|limit/i);
  assert.equal(cancelled, true);
});

test("bounds a request that never resolves", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  let requestSignal;
  const pending = checkClaudeDesktopUpdate({
    ...baseOptions,
    request: (_input, init) => {
      requestSignal = init.signal;
      return new Promise(() => {});
    },
  });
  const rejected = assert.rejects(pending, /timed out|timeout/i);
  context.mock.timers.tick(60000);
  await rejected;
  assert.equal(requestSignal.aborted, true);
});

test("keeps the deadline active while reading a stalled response body", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  let cancelled = false;
  let started;
  const reading = new Promise((resolve) => { started = resolve; });
  const body = new ReadableStream({
    pull() { started(); },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 });
  const pending = checkClaudeDesktopUpdate({
    ...baseOptions,
    request: async () => new Response(body, { headers: { "content-type": "application/json" } }),
  });
  const rejected = assert.rejects(pending, /timed out|timeout/i);
  await reading;
  context.mock.timers.tick(60000);
  await rejected;
  assert.equal(cancelled, true);
});

test("aborts an in-flight check when the Tweak stops", async () => {
  const controller = new AbortController();
  let requestSignal;
  const pending = checkClaudeDesktopUpdate({
    ...baseOptions,
    signal: controller.signal,
    request: (_input, init) => {
      requestSignal = init.signal;
      return new Promise(() => {});
    },
  });
  const rejected = assert.rejects(pending, /stopped/);
  controller.abort(new Error("Tweak stopped"));
  await rejected;
  assert.equal(requestSignal.aborted, true);
});

test("does not start a request if its lifecycle signal is already aborted", async () => {
  const controller = new AbortController();
  controller.abort(new Error("Tweak stopped"));
  let requested = false;
  await assert.rejects(checkClaudeDesktopUpdate({
    ...baseOptions,
    signal: controller.signal,
    request: async () => { requested = true; return jsonResponse(feed("2.26454.2")); },
  }), /stopped/);
  assert.equal(requested, false);
});

test("preserves network failures instead of returning a false no-update result", async () => {
  await assert.rejects(checkClaudeDesktopUpdate({
    ...baseOptions,
    request: async () => { throw new Error("Network offline"); },
  }), /Network offline/);
});

for (const overrides of [
  { arch: "ia32" },
  { currentVersion: "invalid" },
  { deviceId: "" },
  { deviceId: "private machine identifier" },
]) {
  test(`rejects invalid input before requesting metadata ${JSON.stringify(overrides)}`, async () => {
    let requested = false;
    await assert.rejects(checkClaudeDesktopUpdate({
      ...baseOptions,
      ...overrides,
      request: async () => { requested = true; return jsonResponse(feed("2.26454.2")); },
    }), /architecture|version|device/i);
    assert.equal(requested, false);
  });
}

function feed(version, notes = "Release notes") {
  return {
    currentRelease: version,
    releases: [{
      version,
      updateTo: {
        name: "Claude Desktop",
        version,
        pub_date: "2026-10-01T00:00:00Z",
        url: "https://example.invalid/never-download.msix",
        notes,
      },
    }],
  };
}

function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}
