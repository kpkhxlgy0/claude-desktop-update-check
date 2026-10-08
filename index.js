let pageHandle = null;
let mainState = null;
const activeViews = new Set();

function startMain(api) {
  const { app, net, autoUpdater, dialog, shell } = require('electron');
  const os = require('node:os');
  const { randomUUID } = require('node:crypto');
  const { checkClaudeDesktopUpdate } = require('./update-check.cjs');
  const { createNativeUpdateController } = require('./native-update.cjs');
  const state = { active: true, pending: null, controller: null, lastResult: null, native: null };
  mainState = state;

  function ensureActive() {
    if (!state.active) throw new Error('Claude 更新检查已停止');
  }
  function getDeviceId() {
    ensureActive();
    let deviceId = api.storage.get('deviceId');
    if (typeof deviceId !== 'string' || !deviceId) {
      deviceId = randomUUID();
      api.storage.set('deviceId', deviceId);
    }
    return deviceId;
  }
  state.native = createNativeUpdateController({
    autoUpdater,
    platform: process.platform,
    windowsStore: process.windowsStore,
    arch: process.arch,
    currentVersion: app.getVersion(),
    osVersion: os.release(),
    getDeviceId,
    async confirmRestart() {
      ensureActive();
      const result = await dialog.showMessageBox({
        type: 'question',
        title: '重启并安装 Claude 更新',
        message: '重启安装将关闭所有 Claude 窗口，请先完成当前任务。',
        detail: '确认后 Claude 将重启并安装已下载的更新。即使取消，已下载的更新也可能在下一次启动时应用。',
        buttons: ['取消', '重启并安装'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      return state.active && result.response === 1;
    },
    onChange(snapshot) {
      if (state.active) api.ipc.send('native-update-state', snapshot);
    },
  });
  api.ipc.handle('get-version', () => {
    ensureActive();
    return app.getVersion();
  });
  api.ipc.handle('check-update', () => {
    ensureActive();
    if (['checking', 'downloading', 'confirming', 'restarting'].includes(state.native.getState().phase)) {
      throw new Error('Claude 正在更新，请等待更新完成。');
    }
    if (state.pending) return state.pending;
    state.lastResult = null;
    const deviceId = getDeviceId();
    state.controller = new AbortController();
    const signal = state.controller.signal;
    const pending = Promise.resolve().then(() => checkClaudeDesktopUpdate({
      currentVersion: app.getVersion(),
      arch: process.arch,
      osVersion: os.release(),
      deviceId,
      request: net.fetch.bind(net),
      signal,
    })).then((result) => {
      if (state.active) {
        state.lastResult = result;
        api.log.info('Claude 手动更新检查完成', `当前版本 ${result.currentVersion}，官方最新版本 ${result.latestVersion ?? '未返回'}`);
      }
      return result;
    }).finally(() => {
      if (state.pending === pending) {
        state.pending = null;
        state.controller = null;
      }
    });
    state.pending = pending;
    return pending;
  });
  api.ipc.handle('get-native-update-state', () => {
    ensureActive();
    return state.native.getState();
  });
  api.ipc.handle('start-native-update', () => {
    ensureActive();
    const snapshot = state.native.getState();
    if (['checking', 'downloading', 'ready', 'confirming', 'restarting'].includes(snapshot.phase)) return snapshot;
    if (state.pending || !state.lastResult?.updateAvailable) throw new Error('请先检查更新并确认有新版本。');
    return state.native.start();
  });
  api.ipc.handle('restart-native-update', () => {
    ensureActive();
    // The native dialog can remain open beyond the Runtime IPC timeout.
    // The controller owns confirmation errors and broadcasts each transition.
    void state.native.restart();
    return state.native.getState();
  });
  api.ipc.handle('open-release-notes', () => {
    ensureActive();
    return shell.openExternal('https://support.claude.com/en/articles/12138966-release-notes');
  });
  api.log.info('Claude 更新检查已启动', `当前版本 ${app.getVersion()}`);
  const native = state.native.getState();
  api.log.info('Claude 原生更新能力', `supported=${native.supported} phase=${native.phase} platform=${process.platform} windowsStore=${process.windowsStore === true} electron=${process.versions?.electron ?? '未知'}`);
}

function renderPage(api, root) {
  const document = root.ownerDocument;
  let active = true;
  let busy = false;
  let checked = false;
  let updateAvailable = false;
  let nativePending = false;
  let nativeRevision = 0;
  let nativeState = { phase: 'idle', supported: false, message: null, version: null, startedAt: null };
  let showNativeTerminalMessage = true;
  let metadataStatus = '点击检查按钮查询官方版本信息。';
  let waitingTimer = null;
  let activityAnimation = null;
  const reducedMotion = document.defaultView?.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true;

  const page = document.createElement('section');
  page.style.cssText = 'display:flex;flex-direction:column;gap:16px;max-width:620px;color:inherit;';

  const description = document.createElement('p');
  description.textContent = '检查更新仅查询官方版本信息；点击“更新 Claude”后下载，完成后可确认重启安装。下载完成后也可能在下次启动时安装。';
  description.style.cssText = 'margin:0;font-size:13px;opacity:.75;';
  page.appendChild(description);

  const versions = document.createElement('dl');
  versions.style.cssText = 'display:grid;grid-template-columns:auto 1fr;gap:12px 24px;margin:0;padding:16px;border:1px solid rgba(127,127,127,.25);border-radius:12px;font-size:14px;';
  const currentVersion = document.createElement('dd');
  const latestVersion = document.createElement('dd');
  for (const [label, value] of [['当前版本', currentVersion], ['官方最新版本', latestVersion]]) {
    const term = document.createElement('dt');
    term.textContent = label;
    term.style.cssText = 'opacity:.75;';
    value.textContent = '—';
    value.style.cssText = 'margin:0;overflow-wrap:anywhere;';
    versions.append(term, value);
  }
  page.appendChild(versions);

  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = '检查更新（不下载）';
  button.style.cssText = 'align-self:flex-start;border:1px solid rgba(127,127,127,.3);border-radius:8px;background:transparent;color:inherit;padding:8px 12px;font:inherit;font-size:13px;cursor:pointer;';
  const actions = document.createElement('div');
  actions.style.cssText = 'display:flex;gap:12px;flex-wrap:wrap;';
  const updateButton = document.createElement('button');
  updateButton.type = 'button';
  updateButton.textContent = '更新 Claude';
  updateButton.style.cssText = button.style.cssText;
  updateButton.disabled = true;
  actions.append(button, updateButton);
  page.appendChild(actions);

  const status = document.createElement('p');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  status.textContent = metadataStatus;
  status.style.cssText = 'margin:0;font-size:13px;';
  page.appendChild(status);

  const activity = document.createElement('div');
  activity.hidden = true;
  activity.setAttribute('aria-label', '原生更新活动');
  activity.style.cssText = 'width:100%;max-width:360px;';
  const activityTrack = document.createElement('div');
  activityTrack.setAttribute('aria-hidden', 'true');
  activityTrack.style.cssText = 'height:8px;overflow:hidden;border-radius:4px;background:rgba(127,127,127,.2);';
  const activityBar = document.createElement('span');
  activityBar.style.cssText = 'display:block;width:35%;height:100%;border-radius:4px;background:currentColor;opacity:.7;';
  activityTrack.appendChild(activityBar);
  const activityExplanation = document.createElement('p');
  activityExplanation.textContent = '原生更新器不提供百分比；活动条仅表示等待原生反馈。';
  activityExplanation.style.cssText = 'margin:8px 0 0;font-size:13px;opacity:.75;';
  const elapsed = document.createElement('p');
  elapsed.setAttribute('aria-label', '更新等待时长');
  elapsed.setAttribute('aria-live', 'off');
  elapsed.style.cssText = 'margin:8px 0 0;font-size:13px;';
  const longWait = document.createElement('p');
  longWait.setAttribute('aria-live', 'off');
  longWait.style.cssText = 'margin:8px 0 0;font-size:13px;';
  activity.append(activityTrack, activityExplanation, elapsed, longWait);
  page.appendChild(activity);

  const notesSection = document.createElement('section');
  notesSection.hidden = true;
  const notesHeading = document.createElement('h3');
  notesHeading.textContent = '更新说明';
  notesHeading.style.cssText = 'margin:0 0 8px;font-size:14px;font-weight:600;';
  const notes = document.createElement('pre');
  notes.style.cssText = 'margin:0;white-space:pre-wrap;overflow-wrap:anywhere;font:inherit;font-size:13px;line-height:1.6;';
  notesSection.append(notesHeading, notes);
  page.appendChild(notesSection);

  const productNotes = document.createElement('section');
  const productNotesDescription = document.createElement('p');
  productNotesDescription.textContent = '官方更新记录覆盖 Claude 产品整体，不与安装包版本逐一对应。';
  productNotesDescription.style.cssText = 'margin:0 0 8px;font-size:13px;opacity:.75;';
  const notesButton = document.createElement('button');
  notesButton.type = 'button';
  notesButton.textContent = '查看官方产品更新记录';
  notesButton.style.cssText = button.style.cssText;
  const notesStatus = document.createElement('p');
  notesStatus.setAttribute('role', 'status');
  notesStatus.setAttribute('aria-live', 'polite');
  notesStatus.style.cssText = 'margin:8px 0 0;font-size:13px;';
  notesStatus.hidden = true;
  productNotes.append(productNotesDescription, notesButton, notesStatus);
  page.appendChild(productNotes);
  root.appendChild(page);

  function renderWaitingTime() {
    const now = Date.now();
    const startedAt = nativeState.startedAt;
    if (typeof startedAt !== 'number' || !Number.isFinite(startedAt) || startedAt > now) {
      elapsed.textContent = '无法获取开始时间。';
      longWait.textContent = '';
      longWait.hidden = true;
      return;
    }
    const seconds = Math.floor((now - startedAt) / 1000);
    elapsed.textContent = `更新操作已等待 ${seconds} 秒。`;
    longWait.textContent = seconds >= 120 ? '尚未收到完成或错误反馈，无法判断是否停滞。' : '';
    longWait.hidden = seconds < 120;
  }
  function syncActivity() {
    const animated = ['checking', 'downloading', 'restarting'].includes(nativeState.phase);
    const waiting = ['checking', 'downloading'].includes(nativeState.phase);
    activity.hidden = !animated;
    activityExplanation.hidden = !waiting;
    elapsed.hidden = !waiting;
    longWait.hidden = !waiting;
    if (animated && !activityAnimation && !reducedMotion && typeof activityBar.animate === 'function') {
      activityAnimation = activityBar.animate([
        { transform: 'translateX(-100%)' },
        { transform: 'translateX(385%)' },
      ], { duration: 1200, iterations: Infinity });
    } else if (!animated && activityAnimation) {
      activityAnimation.cancel();
      activityAnimation = null;
    }
    if (waiting) {
      renderWaitingTime();
      if (waitingTimer === null) waitingTimer = setInterval(renderWaitingTime, 1000);
    } else {
      if (waitingTimer !== null) clearInterval(waitingTimer);
      waitingTimer = null;
      elapsed.textContent = '';
      longWait.textContent = '';
    }
  }

  function refresh() {
    const nativeBusy = ['checking', 'downloading', 'confirming', 'restarting'].includes(nativeState.phase);
    button.disabled = busy || nativePending || nativeBusy;
    updateButton.textContent = ['ready', 'confirming'].includes(nativeState.phase) ? '重启安装' : '更新 Claude';
    updateButton.disabled = busy || nativePending || nativeBusy || !nativeState.supported ||
      (nativeState.phase !== 'ready' && !updateAvailable);
    syncActivity();
    status.setAttribute('aria-busy', String(busy || nativePending || nativeBusy));
    const messages = {
      checking: '原生更新器正在检查并准备下载…',
      downloading: 'Windows 正在下载并准备更新…',
      ready: `更新已下载${nativeState.version ? `（${nativeState.version}）` : ''}。点击“重启安装”后确认安装。`,
      confirming: '请在确认对话框中选择是否重启安装。',
      restarting: '正在重启 Claude 并安装更新…',
      error: nativeState.message || '更新失败，请稍后重试。',
      unavailable: `${metadataStatus} ${nativeState.message || '当前安装方式不支持原生更新。'}`,
    };
    const hideTerminalMessage = ['idle', 'error'].includes(nativeState.phase) && !showNativeTerminalMessage;
    status.textContent = hideTerminalMessage || (busy && nativeState.phase !== 'error')
      ? metadataStatus
      : messages[nativeState.phase] ?? nativeState.message ?? metadataStatus;
  }
  function applyNativeState(snapshot, showTerminalMessage = true) {
    if (!active) return;
    nativeState = snapshot;
    showNativeTerminalMessage = showTerminalMessage;
    refresh();
  }
  const unsubscribe = api.ipc.on('native-update-state', (snapshot) => {
    if (!active) return;
    nativeRevision += 1;
    applyNativeState(snapshot);
  });

  async function check(event) {
    event.preventDefault();
    event.stopPropagation();
    if (!active || button.disabled) return;
    busy = true;
    checked = true;
    updateAvailable = false;
    showNativeTerminalMessage = false;
    metadataStatus = '正在查询官方版本信息…';
    latestVersion.textContent = '—';
    notes.textContent = '';
    notesSection.hidden = true;
    refresh();
    try {
      const result = await api.ipc.invoke('check-update');
      if (!active) return;
      currentVersion.textContent = result.currentVersion;
      latestVersion.textContent = result.latestVersion ?? '—';
      updateAvailable = result.updateAvailable === true;
      metadataStatus = result.latestVersion === null
        ? '官方接口未返回新版信息'
        : result.updateAvailable ? '发现新版本。' : '当前版本无需更新。';
      if (result.latestVersion !== null) {
        const releaseNotes = typeof result.releaseNotes === 'string' ? result.releaseNotes : '';
        const normalizedNotes = releaseNotes.trim();
        notes.textContent = !normalizedNotes || /^Production Release - No Notes$/i.test(normalizedNotes)
          ? '此版本接口未提供详细更新说明。'
          : releaseNotes;
        notesSection.hidden = false;
      }
    } catch (error) {
      if (!active) return;
      metadataStatus = /timeout|timed out|超时/i.test(String(error?.message ?? error))
        ? '检查超时，请稍后重试。'
        : '检查失败，请检查网络连接后重试。';
    } finally {
      if (active) {
        busy = false;
        refresh();
      }
    }
  }
  button.addEventListener('click', check);

  async function update(event) {
    event.preventDefault();
    event.stopPropagation();
    if (!active || updateButton.disabled) return;
    const revision = nativeRevision;
    nativePending = true;
    refresh();
    try {
      const snapshot = await api.ipc.invoke(nativeState.phase === 'ready' ? 'restart-native-update' : 'start-native-update');
      if (active && nativeRevision === revision) applyNativeState(snapshot);
    } catch (error) {
      if (active && nativeRevision === revision) {
        applyNativeState({ ...nativeState, phase: 'error', message: String(error?.message ?? error) });
      }
    } finally {
      if (active) {
        nativePending = false;
        refresh();
      }
    }
  }
  updateButton.addEventListener('click', update);

  async function openNotes(event) {
    event.preventDefault();
    event.stopPropagation();
    if (!active || notesButton.disabled) return;
    notesButton.disabled = true;
    notesStatus.textContent = '';
    notesStatus.hidden = true;
    try {
      await api.ipc.invoke('open-release-notes');
    } catch {
      if (active) {
        notesStatus.textContent = '无法打开官方产品更新记录，请稍后重试。';
        notesStatus.hidden = false;
      }
    } finally {
      if (active) notesButton.disabled = false;
    }
  }
  notesButton.addEventListener('click', openNotes);

  Promise.resolve().then(() => api.ipc.invoke('get-version')).then((version) => {
    if (active) currentVersion.textContent = version;
  }).catch(() => {
    if (active && !checked) {
      currentVersion.textContent = '无法读取';
      metadataStatus = '无法读取当前版本，请稍后重试。';
      refresh();
    }
  });
  const initialRevision = nativeRevision;
  Promise.resolve().then(() => api.ipc.invoke('get-native-update-state')).then((snapshot) => {
    if (active && nativeRevision === initialRevision) {
      applyNativeState(snapshot, !checked);
    }
  }).catch(() => {
    if (active && nativeRevision === initialRevision) {
      applyNativeState({ phase: 'unavailable', supported: false, message: '无法读取原生更新状态，请重新打开此页面。', version: null });
    }
  });

  function cleanup() {
    if (!active) return;
    active = false;
    button.removeEventListener('click', check);
    updateButton.removeEventListener('click', update);
    notesButton.removeEventListener('click', openNotes);
    if (waitingTimer !== null) clearInterval(waitingTimer);
    waitingTimer = null;
    activityAnimation?.cancel();
    activityAnimation = null;
    unsubscribe();
    page.remove();
    activeViews.delete(cleanup);
  }
  activeViews.add(cleanup);
  return cleanup;
}

module.exports = {
  start(api) {
    if (api.process === 'main') {
      startMain(api);
    } else if (api.process === 'renderer') {
      pageHandle = api.settings.registerPage({
        id: 'main',
        title: 'Claude 更新检查',
        iconSvg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="10" cy="10" r="6.5"/><path d="m7 10 2 2 4-4m2 7 5.5 5.5"/></svg>',
        render: (root) => renderPage(api, root),
      });
      api.log?.info('Claude 更新检查配置页已注册');
    }
  },
  stop() {
    if (mainState) {
      mainState.active = false;
      mainState.controller?.abort();
      mainState.native?.dispose();
      mainState = null;
      // Runtime removes the owned IPC handlers when it disposes this lease.
    }
    for (const cleanup of [...activeViews]) cleanup();
    pageHandle?.unregister();
    pageHandle = null;
  },
};
