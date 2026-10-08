let pageHandle = null;
let mainState = null;
const activeViews = new Set();

function startMain(api) {
  const { app, net } = require('electron');
  const os = require('node:os');
  const { randomUUID } = require('node:crypto');
  const { checkClaudeDesktopUpdate } = require('./update-check.cjs');
  const state = { active: true, pending: null, controller: null };
  mainState = state;

  function ensureActive() {
    if (!state.active) throw new Error('Claude 更新检查已停止');
  }
  api.ipc.handle('get-version', () => {
    ensureActive();
    return app.getVersion();
  });
  api.ipc.handle('check-update', () => {
    ensureActive();
    if (state.pending) return state.pending;
    let deviceId = api.storage.get('deviceId');
    if (typeof deviceId !== 'string' || !deviceId) {
      deviceId = randomUUID();
      api.storage.set('deviceId', deviceId);
    }
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
      if (state.active) api.log.info('Claude 手动更新检查完成', `当前版本 ${result.currentVersion}，官方最新版本 ${result.latestVersion ?? '未返回'}`);
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
  api.log.info('Claude 更新检查已启动', `当前版本 ${app.getVersion()}`);
}

function renderPage(api, root) {
  const document = root.ownerDocument;
  let active = true;
  let busy = false;
  let checked = false;

  const page = document.createElement('section');
  page.style.cssText = 'display:flex;flex-direction:column;gap:16px;max-width:620px;color:inherit;';

  const description = document.createElement('p');
  description.textContent = '仅查询官方版本信息，不下载或安装更新。';
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
  page.appendChild(button);

  const status = document.createElement('p');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  status.textContent = '点击按钮查询官方版本信息。';
  status.style.cssText = 'margin:0;font-size:13px;';
  page.appendChild(status);

  const notesSection = document.createElement('section');
  notesSection.hidden = true;
  const notesHeading = document.createElement('h3');
  notesHeading.textContent = '更新说明';
  notesHeading.style.cssText = 'margin:0 0 8px;font-size:14px;font-weight:600;';
  const notes = document.createElement('pre');
  notes.style.cssText = 'margin:0;white-space:pre-wrap;overflow-wrap:anywhere;font:inherit;font-size:13px;line-height:1.6;';
  notesSection.append(notesHeading, notes);
  page.appendChild(notesSection);
  root.appendChild(page);

  async function check(event) {
    event.preventDefault();
    event.stopPropagation();
    if (!active || busy) return;
    busy = true;
    checked = true;
    button.disabled = true;
    status.textContent = '正在查询官方版本信息…';
    latestVersion.textContent = '—';
    notes.textContent = '';
    notesSection.hidden = true;
    try {
      const result = await api.ipc.invoke('check-update');
      if (!active) return;
      currentVersion.textContent = result.currentVersion;
      latestVersion.textContent = result.latestVersion ?? '—';
      status.textContent = result.latestVersion === null
        ? '官方接口未返回新版信息'
        : result.updateAvailable ? '发现新版本。' : '当前版本无需更新。';
      if (result.releaseNotes) {
        notes.textContent = result.releaseNotes === 'Production Release - No Notes'
          ? '官方接口未提供详细更新说明。'
          : result.releaseNotes;
        notesSection.hidden = false;
      }
    } catch (error) {
      if (!active) return;
      status.textContent = /timeout|timed out|超时/i.test(String(error?.message ?? error))
        ? '检查超时，请稍后重试。'
        : '检查失败，请检查网络连接后重试。';
    } finally {
      if (active) {
        busy = false;
        button.disabled = false;
      }
    }
  }
  button.addEventListener('click', check);

  Promise.resolve().then(() => api.ipc.invoke('get-version')).then((version) => {
    if (active) currentVersion.textContent = version;
  }).catch(() => {
    if (active && !checked) {
      currentVersion.textContent = '无法读取';
      status.textContent = '无法读取当前版本，请稍后重试。';
    }
  });

  function cleanup() {
    if (!active) return;
    active = false;
    button.removeEventListener('click', check);
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
        render: (root) => renderPage(api, root),
      });
      api.log?.info('Claude 更新检查配置页已注册');
    }
  },
  stop() {
    if (mainState) {
      mainState.active = false;
      mainState.controller?.abort();
      mainState = null;
      // Runtime removes the owned IPC handlers when it disposes this lease.
    }
    for (const cleanup of [...activeViews]) cleanup();
    pageHandle?.unregister();
    pageHandle = null;
  },
};
