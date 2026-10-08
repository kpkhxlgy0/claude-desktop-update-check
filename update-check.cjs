const { release } = require("node:os");

const MAX_METADATA_BYTES = 256 * 1024;
const CHECK_TIMEOUT_MS = 4000;

/**
 * Queries release metadata only. The caller owns its independently generated
 * rollout UUID; no native device ID or installer is read or used here.
 *
 * @param {{currentVersion: string, deviceId: string, arch?: string,
 *   osVersion?: string, request?: typeof fetch, signal?: AbortSignal}} options
 * @returns {Promise<{currentVersion: string, latestVersion: string|null,
 *   updateAvailable: boolean, releaseNotes: string|null}>}
 */
async function checkClaudeDesktopUpdate(options) {
  const current = parseVersion(options.currentVersion);
  const arch = options.arch ?? process.arch;
  if (arch !== "x64" && arch !== "arm64") {
    throw new Error(`Unsupported Claude Desktop update architecture: ${arch}`);
  }
  if (typeof options.deviceId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(options.deviceId)) {
    throw new Error("Claude Desktop update deviceId must be a generated UUID");
  }
  options.signal?.throwIfAborted();

  const url = new URL(`https://api.anthropic.com/api/desktop/win32/${arch}/msix/update`);
  url.searchParams.set("version", options.currentVersion);
  url.searchParams.set("os_version", options.osVersion ?? release());
  url.searchParams.set("device_id", options.deviceId);

  const controller = new AbortController();
  const relayAbort = () => controller.abort(options.signal.reason);
  options.signal?.addEventListener("abort", relayAbort, { once: true });
  let rejectAbort;
  const aborted = new Promise((_resolve, reject) => { rejectAbort = reject; });
  const onAbort = () => rejectAbort(controller.signal.reason);
  controller.signal.addEventListener("abort", onAbort, { once: true });
  const timeout = setTimeout(() => {
    controller.abort(new Error("Claude Desktop update metadata check timed out"));
  }, CHECK_TIMEOUT_MS);

  try {
    return await Promise.race([
      requestMetadata(options.request ?? fetch, url, controller.signal, options.currentVersion, current),
      aborted,
    ]);
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", relayAbort);
    controller.signal.removeEventListener("abort", onAbort);
  }
}

async function requestMetadata(request, url, signal, currentVersion, current) {
  const response = await request(url, {
    method: "GET",
    redirect: "error",
    credentials: "omit",
    headers: { Accept: "application/json" },
    signal,
  });
  try {
    signal.throwIfAborted();
    if (response.redirected || (response.status >= 300 && response.status < 400)) {
      throw new Error("Claude Desktop update metadata redirects are not allowed");
    }
    if (response.status === 204 || response.status === 404) {
      return { currentVersion, latestVersion: null, updateAvailable: false, releaseNotes: null };
    }
    if (!response.ok) throw new Error(`Claude Desktop update metadata returned HTTP ${response.status}`);
    if (!/^application\/(?:[\w.+-]+\+)?json(?:\s*;|$)/i.test(response.headers.get("content-type") ?? "")) {
      throw new Error("Claude Desktop update metadata content type must be JSON");
    }
    const length = response.headers.get("content-length");
    if (length !== null && Number(length) > MAX_METADATA_BYTES) {
      throw new Error("Claude Desktop update metadata exceeds the size limit");
    }
    const metadata = await readMetadata(response, signal);
    return describeRelease(metadata, currentVersion, current);
  } finally {
    if (response.body && !response.body.locked) void response.body.cancel().catch(() => {});
  }
}

async function readMetadata(response, signal) {
  if (!response.body) throw new Error("Claude Desktop update metadata body is empty");
  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel(signal.reason).catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_METADATA_BYTES) throw new Error("Claude Desktop update metadata exceeds the size limit");
      chunks.push(value);
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  try {
    return JSON.parse(Buffer.concat(chunks, size).toString("utf8"));
  } catch (error) {
    throw new Error("Claude Desktop update metadata is invalid JSON", { cause: error });
  }
}

function describeRelease(metadata, currentVersion, current) {
  if (!isObject(metadata)) throw new Error("Claude Desktop update metadata must be an object");
  const latest = parseVersion(metadata.currentRelease ?? metadata.version);
  if (metadata.releases !== undefined && !Array.isArray(metadata.releases)) {
    throw new Error("Claude Desktop update metadata releases must be an array");
  }
  let releaseNotes = null;
  for (const item of metadata.releases ?? []) {
    if (!isObject(item)) throw new Error("Claude Desktop update metadata release must be an object");
    parseVersion(item.version);
    if (item.updateTo === undefined || item.updateTo === null) continue;
    if (!isObject(item.updateTo)) throw new Error("Claude Desktop update metadata updateTo must be an object");
    const target = parseVersion(item.updateTo.version);
    const notes = item.updateTo.notes;
    if (notes !== undefined && notes !== null && typeof notes !== "string") {
      throw new Error("Claude Desktop update metadata release notes must be text");
    }
    if (compareVersions(target, latest) === 0 && releaseNotes === null) releaseNotes = notes ?? null;
  }
  return {
    currentVersion,
    latestVersion: latest.version,
    updateAvailable: compareVersions(latest, current) > 0,
    releaseNotes,
  };
}

function parseVersion(value) {
  if (typeof value !== "string" || !/^\d+\.\d+\.\d+(?:\.\d+)?$/.test(value)) {
    throw new Error("Claude Desktop update version must have three or four numeric components");
  }
  const parts = value.split(".").map((part) => BigInt(part));
  if (parts.length === 4 && parts[3] === 0n) parts.pop();
  return { parts, version: parts.join(".") };
}

function compareVersions(left, right) {
  for (let index = 0; index < 4; index += 1) {
    const a = left.parts[index] ?? 0n;
    const b = right.parts[index] ?? 0n;
    if (a > b) return 1;
    if (a < b) return -1;
  }
  return 0;
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

module.exports = { checkClaudeDesktopUpdate };
