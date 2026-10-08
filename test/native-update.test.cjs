const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");
const { createNativeUpdateController } = require("../native-update.cjs");

const baseOptions = {
  platform: "win32",
  windowsStore: true,
  arch: "x64",
  currentVersion: "2.26454.1.0",
  osVersion: "10.0.26100",
  getDeviceId: () => "93d6dd7c-2c79-4f6b-98b6-a9102c4dbe13",
};

function nativeUpdater() {
  const updater = new EventEmitter();
  updater.calls = [];
  updater.setFeedURL = (options) => { updater.calls.push(["feed", options]); };
  updater.checkForUpdates = () => { updater.calls.push(["check"]); };
  updater.quitAndInstall = () => { updater.calls.push(["install"]); };
  return updater;
}

function create(updater, options = {}) {
  return createNativeUpdateController({ ...baseOptions, autoUpdater: updater, ...options });
}

function downloaded(updater, version = "2.26454.2") {
  updater.emit("update-downloaded", {}, "Release notes", version, new Date("2026-10-08"), "https://downloads.example.invalid/Claude.msix");
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function settle() {
  await new Promise((resolve) => setImmediate(resolve));
}

test("opening and reading the controller never starts native update work or creates a rollout ID", () => {
  const updater = nativeUpdater();
  const controller = create(updater, {
    getDeviceId() { assert.fail("rollout ID must be deferred until Update"); },
    confirmRestart() { assert.fail("restart confirmation must be explicit"); },
    now() { assert.fail("elapsed time must not begin before Update"); },
  });
  assert.deepEqual(controller.getState(), {
    phase: "idle", supported: true, message: null, version: null, startedAt: null,
  });
  const snapshot = controller.getState();
  snapshot.phase = "ready";
  assert.equal(controller.getState().phase, "idle");
  assert.equal(JSON.stringify(controller.getState()), '{"phase":"idle","supported":true,"message":null,"version":null,"startedAt":null}');
  assert.deepEqual(updater.calls, []);
  assert.deepEqual(updater.eventNames(), []);
  controller.dispose();
});

for (const arch of ["x64", "arm64"]) {
  test(`only an explicit Update call configures and checks the official ${arch} MSIX feed`, () => {
    const updater = nativeUpdater();
    const controller = create(updater, { arch });
    const state = controller.start();
    assert.equal(state.phase, "checking");
    assert.deepEqual(updater.calls, [
      ["feed", {
        url: `https://api.anthropic.com/api/desktop/win32/${arch}/msix/update?version=2.26454.1.0&os_version=10.0.26100&device_id=93d6dd7c-2c79-4f6b-98b6-a9102c4dbe13`,
        serverType: "json",
      }],
      ["check"],
    ]);
    controller.start();
    assert.equal(updater.calls.length, 2, "repeated clicks must share the native operation");
    updater.emit("update-not-available");
    assert.equal(controller.getState().phase, "idle");
    assert.match(controller.getState().message, /无需更新|最新/);
    controller.dispose();
  });
}

test("native events expose download readiness and the engine's release version", () => {
  const updater = nativeUpdater();
  const changes = [];
  const controller = create(updater, { onChange: (state) => changes.push(state) });
  controller.start();
  updater.emit("checking-for-update");
  updater.emit("update-available");
  assert.equal(controller.getState().phase, "downloading");
  downloaded(updater, "2.26454.2.0");
  assert.equal(controller.getState().phase, "ready");
  assert.equal(controller.getState().version, "2.26454.2.0");
  assert.deepEqual(changes.map((state) => state.phase), ["checking", "downloading", "ready"]);
  assert.equal(updater.calls.filter(([type]) => type === "install").length, 0);
  controller.start();
  assert.equal(updater.calls.filter(([type]) => type === "check").length, 1);
  controller.dispose();
});

test("start returns immediately while a native promise is pending", () => {
  const updater = nativeUpdater();
  const pending = deferred();
  updater.checkForUpdates = () => { updater.calls.push(["check"]); return pending.promise; };
  const controller = create(updater);
  assert.equal(controller.start().phase, "checking");
  assert.equal(typeof controller.start().then, "undefined");
  updater.emit("update-not-available");
  pending.resolve();
  controller.dispose();
});

for (const options of [
  { platform: "darwin" },
  { windowsStore: false },
  { windowsStore: undefined },
  { arch: "ia32" },
  { autoUpdater: undefined },
]) {
  test(`fails closed for an unavailable Windows MSIX updater: ${JSON.stringify(options)}`, async () => {
    const updater = nativeUpdater();
    const controller = create(updater, {
      ...options,
      getDeviceId() { assert.fail("unsupported updater must not create an ID"); },
      now() { assert.fail("unsupported updater must not start elapsed time"); },
    });
    assert.equal(controller.getState().supported, false);
    assert.equal(controller.getState().startedAt, null);
    assert.equal(controller.start().phase, "unavailable");
    assert.equal((await controller.restart()).phase, "unavailable");
    assert.deepEqual(updater.calls, []);
    controller.dispose();
  });
}

for (const method of ["setFeedURL", "checkForUpdates", "quitAndInstall", "on", "removeListener"]) {
  test(`fails closed when the native updater lacks ${method}`, () => {
    const updater = nativeUpdater();
    updater[method] = undefined;
    const controller = create(updater);
    assert.equal(controller.start().phase, "unavailable");
    assert.deepEqual(updater.calls, []);
    controller.dispose();
  });
}

for (const options of [
  { currentVersion: "2.1" },
  { currentVersion: "2.1.0&allowAnyVersion=1" },
  { currentVersion: "" },
  { osVersion: "10.0.26100&version=0" },
  { osVersion: "" },
  { getDeviceId: () => "not-a-uuid" },
  { getDeviceId: () => Promise.resolve(baseOptions.getDeviceId()) },
  { getDeviceId: undefined },
]) {
  test(`invalid feed input never reaches native code: ${JSON.stringify(options)}`, () => {
    const updater = nativeUpdater();
    const controller = create(updater, options);
    assert.equal(controller.start().phase, "error");
    assert.match(controller.getState().message, /版本|系统|UUID|标识/);
    assert.deepEqual(updater.calls, []);
    controller.dispose();
  });
}

test("a thrown rollout-ID error is surfaced without configuring the updater", () => {
  const updater = nativeUpdater();
  const controller = create(updater, { getDeviceId() { throw new Error("ID storage unavailable"); } });
  assert.equal(controller.start().phase, "error");
  assert.match(controller.getState().message, /ID storage unavailable/);
  assert.deepEqual(updater.calls, []);
  controller.dispose();
});

test("multiple leases share the download and remove only their own UI subscriptions", () => {
  const updater = nativeUpdater();
  const hostListener = () => {};
  updater.on("update-downloaded", hostListener);
  const firstChanges = [];
  const secondChanges = [];
  const first = create(updater, { onChange: (state) => firstChanges.push(state.phase) });
  const second = create(updater, { onChange: (state) => secondChanges.push(state.phase) });
  first.start();
  second.start();
  assert.equal(updater.calls.filter(([type]) => type === "check").length, 1);
  assert.equal(updater.listenerCount("update-downloaded"), 2);
  first.dispose();
  first.dispose();
  updater.emit("update-available");
  downloaded(updater);
  assert.deepEqual(firstChanges, ["checking"]);
  assert.deepEqual(secondChanges, ["checking", "downloading", "ready"]);
  assert.equal(second.getState().version, "2.26454.2");
  second.dispose();
  assert.deepEqual(updater.listeners("update-downloaded"), [hostListener]);
  assert.deepEqual(updater.eventNames(), ["update-downloaded"]);
});

test("a download continues to be observed across a tweak reload without starting again", () => {
  const updater = nativeUpdater();
  const first = create(updater);
  first.start();
  first.dispose();
  assert.equal(updater.listenerCount("update-downloaded"), 1);
  updater.emit("update-available");
  const modulePath = require.resolve("../native-update.cjs");
  delete require.cache[modulePath];
  const reloaded = require("../native-update.cjs").createNativeUpdateController({ ...baseOptions, autoUpdater: updater });
  assert.equal(reloaded.getState().phase, "downloading");
  reloaded.start();
  assert.equal(updater.calls.filter(([type]) => type === "check").length, 1);
  downloaded(updater);
  reloaded.dispose();
  assert.deepEqual(updater.eventNames(), []);
  const afterDownload = create(updater);
  assert.equal(afterDownload.getState().phase, "ready");
  assert.equal(afterDownload.getState().version, "2.26454.2");
  afterDownload.start();
  assert.equal(updater.calls.filter(([type]) => type === "check").length, 1);
  afterDownload.dispose();
});

for (const terminalEvent of ["update-not-available", "error"]) {
  test(`unleased native observers detach when ${terminalEvent} finishes the operation`, () => {
    const updater = nativeUpdater();
    const controller = create(updater);
    controller.start();
    controller.dispose();
    updater.emit(terminalEvent, new Error("Download unavailable"));
    assert.deepEqual(updater.eventNames(), []);
    const next = create(updater);
    assert.equal(next.getState().phase, terminalEvent === "error" ? "error" : "idle");
    next.dispose();
  });
}

test("a disposed controller cannot initiate a new update", () => {
  const updater = nativeUpdater();
  const controller = create(updater);
  controller.dispose();
  controller.start();
  assert.deepEqual(updater.calls, []);
});

for (const failingMethod of ["setFeedURL", "checkForUpdates"]) {
  test(`synchronous ${failingMethod} failure produces an error rather than success`, () => {
    const updater = nativeUpdater();
    updater[failingMethod] = () => { throw new Error("Native service unavailable"); };
    const controller = create(updater);
    assert.equal(controller.start().phase, "error");
    assert.match(controller.getState().message, /Native service unavailable/);
    downloaded(updater);
    assert.equal(controller.getState().phase, "error");
    controller.dispose();
  });

  test(`rejected ${failingMethod} work surfaces asynchronously without an unhandled rejection`, async () => {
    const updater = nativeUpdater();
    updater[failingMethod] = () => Promise.reject(new Error("Native promise failed"));
    const changes = [];
    const controller = create(updater, { onChange: (state) => changes.push(state.phase) });
    controller.start();
    await settle();
    assert.equal(controller.getState().phase, "error");
    assert.match(controller.getState().message, /Native promise failed/);
    assert.deepEqual(changes, ["checking", "error"]);
    if (failingMethod === "setFeedURL") assert.deepEqual(updater.calls, []);
    controller.dispose();
  });
}

test("the check waits for asynchronous feed setup without delaying the IPC result", async () => {
  const updater = nativeUpdater();
  const feed = deferred();
  updater.setFeedURL = () => feed.promise;
  const controller = create(updater);
  assert.equal(controller.start().phase, "checking");
  assert.deepEqual(updater.calls, []);
  feed.resolve();
  await settle();
  assert.deepEqual(updater.calls, [["check"]]);
  updater.emit("update-not-available");
  controller.dispose();
});

test("a stale check rejection cannot overwrite the result of a newer retry", async () => {
  const updater = nativeUpdater();
  const oldCheck = deferred();
  let checks = 0;
  updater.checkForUpdates = () => (++checks === 1 ? oldCheck.promise : undefined);
  const controller = create(updater);
  controller.start();
  updater.emit("error", new Error("First check failed"));
  controller.start();
  downloaded(updater);
  oldCheck.reject(new Error("Stale rejection"));
  await settle();
  assert.equal(controller.getState().phase, "ready");
  assert.equal(checks, 2);
  controller.dispose();
});

test("native errors update the UI and a subsequent explicit Update can retry", () => {
  const updater = nativeUpdater();
  const controller = create(updater);
  controller.start();
  updater.emit("error", new Error("The native download failed"));
  assert.equal(controller.getState().phase, "error");
  assert.match(controller.getState().message, /native download failed/);
  controller.start();
  assert.equal(controller.getState().phase, "checking");
  assert.equal(updater.calls.filter(([type]) => type === "check").length, 2);
  updater.emit("update-not-available");
  controller.dispose();
});

test("observer failures and mutated snapshots cannot corrupt the shared native operation", () => {
  const updater = nativeUpdater();
  const controller = create(updater, { onChange(state) { state.phase = "idle"; throw new Error("Unmounted view"); } });
  controller.start();
  assert.equal(controller.getState().phase, "checking");
  downloaded(updater);
  assert.equal(controller.getState().phase, "ready");
  controller.dispose();
});

test("restart before download readiness does not show a confirmation or install", async () => {
  const updater = nativeUpdater();
  const controller = create(updater, { confirmRestart() { assert.fail("not ready"); } });
  await controller.restart();
  controller.start();
  await controller.restart();
  updater.emit("update-available");
  await controller.restart();
  assert.equal(updater.calls.filter(([type]) => type === "install").length, 0);
  updater.emit("update-not-available");
  controller.dispose();
});

test("ready updates install only after explicit restart confirmation and only once", async () => {
  const updater = nativeUpdater();
  const confirmation = deferred();
  let confirmations = 0;
  const controller = create(updater, { confirmRestart() { confirmations++; return confirmation.promise; } });
  controller.start();
  downloaded(updater);
  const first = controller.restart();
  assert.equal(controller.getState().phase, "confirming");
  const second = controller.restart();
  controller.start();
  await settle();
  assert.equal(confirmations, 1);
  assert.equal(updater.calls.filter(([type]) => type === "install").length, 0);
  confirmation.resolve(true);
  assert.equal((await first).phase, "restarting");
  assert.equal((await second).phase, "restarting");
  await controller.restart();
  controller.start();
  assert.equal(updater.calls.filter(([type]) => type === "install").length, 1);
  assert.equal(updater.calls.filter(([type]) => type === "check").length, 1);
  assert.equal(controller.getState().version, "2.26454.2");
  controller.dispose();
});

test("two leases share the pending restart dialog and cancellation restores download readiness", async () => {
  const updater = nativeUpdater();
  const confirmation = deferred();
  const phases = [];
  let confirmations = 0;
  const first = create(updater, {
    confirmRestart() { confirmations++; return confirmation.promise; },
    onChange: (state) => phases.push(state.phase),
  });
  first.start();
  downloaded(updater);
  const pending = first.restart();
  const second = create(updater, { confirmRestart() { assert.fail("duplicate dialog"); } });
  const duplicate = second.restart();
  assert.equal(second.getState().phase, "confirming");
  second.start();
  await settle();
  assert.equal(confirmations, 1);
  confirmation.resolve(false);
  assert.equal((await pending).phase, "ready");
  assert.equal((await duplicate).phase, "ready");
  assert.deepEqual(phases, ["checking", "ready", "confirming", "ready"]);
  assert.equal(updater.calls.filter(([type]) => type === "check").length, 1);
  first.dispose();
  second.dispose();
});

test("a native error from a restart notification invalidates the confirmed installation", async () => {
  const updater = nativeUpdater();
  const controller = create(updater, {
    confirmRestart: async () => true,
    onChange(state) { if (state.phase === "restarting") updater.emit("error", new Error("Native state changed")); },
  });
  controller.start();
  downloaded(updater);
  assert.equal((await controller.restart()).phase, "error");
  assert.equal(updater.calls.filter(([type]) => type === "install").length, 0);
  controller.dispose();
});

for (const decision of [false, undefined, "yes"]) {
  test(`a restart confirmation of ${String(decision)} leaves the downloaded update ready`, async () => {
    const updater = nativeUpdater();
    let confirmations = 0;
    const controller = create(updater, { confirmRestart: async () => { confirmations++; return decision; } });
    controller.start();
    downloaded(updater);
    assert.equal((await controller.restart()).phase, "ready");
    assert.equal(confirmations, 1);
    assert.equal(updater.calls.filter(([type]) => type === "install").length, 0);
    controller.dispose();
  });
}

for (const invalidate of ["dispose", "native-error"]) {
  test(`pending restart confirmation cannot install after ${invalidate}`, async () => {
    const updater = nativeUpdater();
    const confirmation = deferred();
    let confirmations = 0;
    const controller = create(updater, { confirmRestart: () => { confirmations++; return confirmation.promise; } });
    controller.start();
    downloaded(updater);
    const result = controller.restart();
    await settle();
    assert.equal(confirmations, 1);
    if (invalidate === "dispose") controller.dispose();
    else updater.emit("error", new Error("Downloaded update no longer available"));
    confirmation.resolve(true);
    await result;
    assert.equal(updater.calls.filter(([type]) => type === "install").length, 0);
    controller.dispose();
  });
}

test("restart fails closed when native confirmation is unavailable", async () => {
  const updater = nativeUpdater();
  const controller = create(updater);
  controller.start();
  downloaded(updater);
  assert.equal((await controller.restart()).phase, "error");
  assert.equal(updater.calls.filter(([type]) => type === "install").length, 0);
  controller.dispose();
});

test("disposing during the restarting notification prevents the native install call", async () => {
  const updater = nativeUpdater();
  let controller;
  controller = create(updater, {
    confirmRestart: async () => true,
    onChange(state) { if (state.phase === "restarting") controller.dispose(); },
  });
  controller.start();
  downloaded(updater);
  await controller.restart();
  assert.equal(updater.calls.filter(([type]) => type === "install").length, 0);
});

test("a rejected confirmation produces a visible error without installing", async () => {
  const updater = nativeUpdater();
  const controller = create(updater, { confirmRestart: () => Promise.reject(new Error("Dialog unavailable")) });
  controller.start();
  downloaded(updater);
  assert.equal((await controller.restart()).phase, "error");
  assert.match(controller.getState().message, /Dialog unavailable/);
  assert.equal(updater.calls.filter(([type]) => type === "install").length, 0);
  controller.dispose();
});

for (const asynchronous of [false, true]) {
  test(`${asynchronous ? "asynchronous" : "synchronous"} installer failure cannot report a successful restart`, async () => {
    const updater = nativeUpdater();
    updater.quitAndInstall = () => {
      updater.calls.push(["install"]);
      if (asynchronous) return Promise.reject(new Error("Installer unavailable"));
      throw new Error("Installer unavailable");
    };
    const controller = create(updater, { confirmRestart: async () => true });
    controller.start();
    downloaded(updater);
    assert.equal((await controller.restart()).phase, "error");
    assert.match(controller.getState().message, /Installer unavailable/);
    await controller.restart();
    assert.equal(updater.calls.filter(([type]) => type === "install").length, 1);
    controller.dispose();
  });
}

for (const reloadWhilePending of [false, true]) {
  test(`a delayed native registration error survives install disposal${reloadWhilePending ? " and reload" : ""}`, async () => {
    const updater = nativeUpdater();
    const hostErrorListener = () => {};
    updater.on("error", hostErrorListener);
    const registration = deferred();
    // MSIX quitAndInstall reports registration failure as an event, then resolves.
    updater.quitAndInstall = async () => {
      updater.calls.push(["install"]);
      try { await registration.promise; }
      catch (error) { updater.emit("error", error, error.message); }
    };
    const first = create(updater, { confirmRestart: async () => true });
    first.start();
    downloaded(updater);
    const restart = first.restart();
    await settle();
    assert.equal(first.getState().phase, "restarting");
    assert.equal(updater.calls.filter(([type]) => type === "install").length, 1);
    first.dispose();

    const changes = [];
    let reloaded;
    if (reloadWhilePending) {
      const modulePath = require.resolve("../native-update.cjs");
      delete require.cache[modulePath];
      reloaded = require("../native-update.cjs").createNativeUpdateController({
        ...baseOptions, autoUpdater: updater, onChange: (state) => changes.push(state.phase),
      });
      assert.equal(reloaded.getState().phase, "restarting");
    }

    registration.reject(new Error("Package registration failed"));
    assert.equal((await restart).phase, "error");
    if (!reloaded) reloaded = create(updater);
    assert.equal(reloaded.getState().phase, "error");
    assert.match(reloaded.getState().message, /Package registration failed/);
    assert.equal(reloaded.getState().version, "2.26454.2");
    if (reloadWhilePending) assert.deepEqual(changes, ["error"]);
    assert.equal(updater.calls.filter(([type]) => type === "install").length, 1);
    reloaded.dispose();
    assert.deepEqual(updater.listeners("error"), [hostErrorListener]);
    assert.deepEqual(updater.eventNames(), ["error"]);
  });
}

test("one fresh Update timestamp survives native phases, confirmation, and restart", async () => {
  const updater = nativeUpdater();
  const changes = [];
  let clockReads = 0;
  const controller = create(updater, {
    now() { clockReads++; return 1791424800000; },
    confirmRestart: async () => true,
    onChange: (state) => changes.push(state),
  });
  assert.equal(controller.start().startedAt, 1791424800000);
  assert.equal(controller.start().startedAt, 1791424800000);
  updater.emit("update-available");
  assert.equal(controller.start().startedAt, 1791424800000);
  downloaded(updater);
  controller.start();
  const restart = controller.restart();
  controller.start();
  assert.equal((await restart).startedAt, 1791424800000);
  assert.equal(clockReads, 1);
  assert.deepEqual(changes.map(({ phase, startedAt }) => ({ phase, startedAt })), [
    { phase: "checking", startedAt: 1791424800000 },
    { phase: "downloading", startedAt: 1791424800000 },
    { phase: "ready", startedAt: 1791424800000 },
    { phase: "confirming", startedAt: 1791424800000 },
    { phase: "restarting", startedAt: 1791424800000 },
  ]);
  assert.equal(JSON.parse(JSON.stringify(controller.getState())).startedAt, 1791424800000);
  controller.dispose();
});

test("explicit retries replace the attempt timestamp while errors and no-update retain it", () => {
  const updater = nativeUpdater();
  const times = [1791424800000, 1791424860000, 1791424920000];
  const changes = [];
  const controller = create(updater, {
    now: () => times.shift(),
    onChange: (state) => changes.push([state.phase, state.startedAt]),
  });
  controller.start();
  updater.emit("error", new Error("Temporary download failure"));
  assert.equal(controller.getState().startedAt, 1791424800000);
  assert.equal(controller.start().startedAt, 1791424860000);
  updater.emit("update-not-available");
  assert.equal(controller.getState().startedAt, 1791424860000);
  assert.equal(controller.start().startedAt, 1791424920000);
  assert.deepEqual(changes, [
    ["checking", 1791424800000], ["error", 1791424800000],
    ["checking", 1791424860000], ["idle", 1791424860000],
    ["checking", 1791424920000],
  ]);
  updater.emit("update-not-available");
  controller.dispose();
});

test("a shared timestamp survives lease and require-cache reload without reading another clock", () => {
  const updater = nativeUpdater();
  const first = create(updater, { now: () => 1791424800000 });
  first.start();
  first.dispose();
  const modulePath = require.resolve("../native-update.cjs");
  delete require.cache[modulePath];
  const changes = [];
  const reloaded = require("../native-update.cjs").createNativeUpdateController({
    ...baseOptions, autoUpdater: updater,
    now() { assert.fail("reload must not fabricate a new attempt time"); },
    onChange: (state) => changes.push(state.startedAt),
  });
  assert.equal(reloaded.getState().startedAt, 1791424800000);
  assert.equal(reloaded.start().startedAt, 1791424800000);
  updater.emit("update-available");
  downloaded(updater);
  assert.equal(reloaded.getState().startedAt, 1791424800000);
  assert.deepEqual(changes, [1791424800000, 1791424800000]);
  assert.equal(updater.calls.filter(([type]) => type === "check").length, 1);
  reloaded.dispose();
});

test("pre-timestamp shared operations report unknown elapsed time until an explicit retry", () => {
  const updater = nativeUpdater();
  const first = create(updater, { now: () => 1791424800000 });
  first.start();
  // Model the live Symbol record from the previous installed controller version.
  const record = updater[Symbol.for("claude-desktop-update-check.native-update.v1")];
  delete record.startedAt;
  delete record.state.startedAt;
  updater.removeListener("update-available", record.listeners["update-available"]);
  record.listeners["update-available"] = () => {
    // The previous controller's event closure replaces state without new fields.
    record.state = { phase: "downloading", supported: true, message: "正在下载更新…", version: null };
    for (const lease of record.leases) if (lease.active) lease.onChange?.({ ...record.state });
  };
  updater.on("update-available", record.listeners["update-available"]);
  first.dispose();
  const changes = [];
  let clockReads = 0;
  const reloaded = create(updater, {
    now() { clockReads++; return 1791424920000; },
    onChange: (state) => changes.push(state.startedAt),
  });
  assert.equal(reloaded.getState().startedAt, null);
  assert.equal(reloaded.start().startedAt, null);
  updater.emit("update-available");
  updater.emit("error", new Error("Retry required"));
  assert.deepEqual(changes, [null, null]);
  assert.equal(clockReads, 0);
  assert.equal(reloaded.start().startedAt, 1791424920000);
  assert.equal(clockReads, 1);
  updater.emit("update-available");
  assert.equal(reloaded.getState().startedAt, 1791424920000);
  assert.deepEqual(changes, [null, null, 1791424920000, 1791424920000]);
  updater.emit("update-not-available");
  reloaded.dispose();
});

test("synchronous start failures keep the timestamp of each explicit attempt", () => {
  const updater = nativeUpdater();
  const changes = [];
  const times = [1791424800000, 1791424860000];
  const controller = create(updater, {
    now: () => times.shift(),
    getDeviceId() { throw new Error("Storage unavailable"); },
    onChange: (state) => changes.push(state.startedAt),
  });
  assert.equal(controller.start().startedAt, 1791424800000);
  assert.equal(controller.start().startedAt, 1791424860000);
  assert.deepEqual(changes, [1791424800000, 1791424860000]);
  assert.deepEqual(updater.calls, []);
  controller.dispose();
});
