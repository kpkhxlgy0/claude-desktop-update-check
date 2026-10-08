const SHARED_UPDATE = Symbol.for("claude-desktop-update-check.native-update.v1");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VERSION = /^\d+\.\d+\.\d+(?:\.\d+)?$/;

/** Manual access to Electron's Windows MSIX updater. Construction never starts it. */
function createNativeUpdateController(options) {
  const updater = options.autoUpdater;
  const supported = options.platform === "win32" && options.windowsStore === true &&
    (options.arch === "x64" || options.arch === "arm64") && updater &&
    ["setFeedURL", "checkForUpdates", "quitAndInstall", "on", "removeListener"]
      .every((method) => typeof updater[method] === "function");
  const lease = { active: true, onChange: options.onChange };
  const unavailable = {
    phase: "unavailable", supported: false,
    message: "当前环境无法使用 Claude 的 Windows MSIX 更新程序。", version: null,
  };
  let record = null;
  if (supported) {
    record = updater[SHARED_UPDATE];
    if (!record) {
      record = {
        updater, state: { phase: "idle", supported: true, message: null, version: null },
        leases: new Set(), listeners: null, generation: 0,
        confirmation: null, installAttempted: false,
      };
      Object.defineProperty(updater, SHARED_UPDATE, { value: record });
    }
    record.leases.add(lease);
  }

  const getState = () => ({ ...(record?.state ?? unavailable) });

  function start() {
    if (!lease.active || !record) return getState();
    if (["checking", "downloading", "ready", "confirming", "restarting"].includes(record.state.phase)) return getState();
    const generation = ++record.generation;
    record.installAttempted = false;
    try {
      const url = buildFeedURL(options);
      attach(record);
      update(record, "checking", "正在调用 Claude 更新程序…", null);
      const result = updater.setFeedURL({ url, serverType: "json" });
      const check = () => {
        if (record.generation !== generation || record.state.phase !== "checking") return;
        const pending = updater.checkForUpdates();
        if (pending && typeof pending.then === "function") {
          Promise.resolve(pending).catch((error) => fail(record, error, generation));
        }
      };
      if (result && typeof result.then === "function") {
        Promise.resolve(result).then(check).catch((error) => fail(record, error, generation));
      } else {
        check();
      }
    } catch (error) {
      fail(record, error, generation);
    }
    return getState();
  }

  function restart() {
    if (!lease.active || !record) return Promise.resolve(getState());
    if (record.confirmation) return record.confirmation;
    if (record.state.phase !== "ready" || record.installAttempted) return Promise.resolve(getState());
    const readyState = record.state;
    const generation = record.generation;
    attach(record);
    update(record, "confirming", "请在确认对话框中选择是否重启安装。");
    const confirmingState = record.state;
    const pending = Promise.resolve().then(() => {
      if (!lease.active || record.state !== confirmingState || record.state.phase !== "confirming") return false;
      if (typeof options.confirmRestart !== "function") throw new Error("无法确认重启安装，请稍后重试。");
      return options.confirmRestart();
    }).then(async (confirmed) => {
      if (confirmed !== true || !lease.active || record.state !== confirmingState || record.state.phase !== "confirming") {
        if (record.state === confirmingState && record.state.phase === "confirming") update(record, "ready", readyState.message);
        return getState();
      }
      update(record, "restarting", "Claude 更新程序正在重启并安装…");
      // A state subscriber may dispose the lease or report a native error here.
      if (!lease.active || record.state.phase !== "restarting" || record.generation !== generation) {
        if (record.state.phase === "restarting") update(record, "ready", readyState.message);
        return getState();
      }
      record.installAttempted = true;
      await updater.quitAndInstall();
      return getState();
    }).catch((error) => {
      if (lease.active || record.installAttempted) fail(record, error, generation);
      return getState();
    }).finally(() => {
      if (record.confirmation === pending) record.confirmation = null;
      detachIfUnused(record);
    });
    record.confirmation = pending;
    return pending;
  }

  function dispose() {
    if (!lease.active) return;
    lease.active = false;
    record?.leases.delete(lease);
    if (record) detachIfUnused(record);
  }

  return { getState, start, restart, dispose };
}

function buildFeedURL(options) {
  if (typeof options.currentVersion !== "string" || options.currentVersion.length > 64 || !VERSION.test(options.currentVersion)) {
    throw new Error("Claude 当前版本必须包含三或四段数字。");
  }
  if (typeof options.osVersion !== "string" || options.osVersion.length > 64 || !VERSION.test(options.osVersion)) {
    throw new Error("Windows 系统版本必须包含三或四段数字。");
  }
  if (typeof options.getDeviceId !== "function") throw new Error("缺少更新标识 UUID。");
  const deviceId = options.getDeviceId();
  if (typeof deviceId !== "string" || !UUID.test(deviceId)) throw new Error("更新标识必须是生成的 UUID。");
  const url = new URL(`https://api.anthropic.com/api/desktop/win32/${options.arch}/msix/update`);
  url.searchParams.set("version", options.currentVersion);
  url.searchParams.set("os_version", options.osVersion);
  url.searchParams.set("device_id", deviceId);
  return url.href;
}

function update(record, phase, message, version = record.state.version) {
  if (record.state.phase === phase && record.state.message === message && record.state.version === version) return;
  record.state = { phase, supported: true, message, version };
  for (const lease of [...record.leases]) {
    if (!lease.active || typeof lease.onChange !== "function") continue;
    try { lease.onChange({ ...record.state }); } catch { /* A disposed UI must not interrupt native work. */ }
  }
  detachIfUnused(record);
}

function fail(record, error, generation) {
  if (record.generation !== generation) return;
  update(record, "error", `Claude 更新失败：${String(error?.message ?? error)}`);
}

function attach(record) {
  if (record.listeners) return;
  const inFlight = () => ["checking", "downloading"].includes(record.state.phase);
  record.listeners = {
    "checking-for-update": () => {},
    "update-available": () => {
      if (inFlight()) update(record, "downloading", "Claude 更新程序正在下载更新…");
    },
    "update-not-available": () => {
      if (inFlight()) update(record, "idle", "当前版本无需更新。", null);
    },
    "update-downloaded": (_event, _notes, releaseName) => {
      if (inFlight()) update(record, "ready", "更新已下载，可以重启并安装。",
        typeof releaseName === "string" && releaseName.trim() ? releaseName : null);
    },
    error: (error) => fail(record, error, record.generation),
  };
  for (const [event, listener] of Object.entries(record.listeners)) record.updater.on(event, listener);
}

function detachIfUnused(record) {
  if (record.leases.size || ["checking", "downloading", "restarting"].includes(record.state.phase) || !record.listeners) return;
  for (const [event, listener] of Object.entries(record.listeners)) record.updater.removeListener(event, listener);
  record.listeners = null;
}

module.exports = { createNativeUpdateController };
