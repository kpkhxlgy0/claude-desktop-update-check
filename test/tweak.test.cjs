const assert = require('node:assert/strict');
const fs = require('node:fs');
const { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const entryPath = path.join(__dirname, '..', 'index.js');

class Element {
  constructor(tagName, ownerDocument) {
    this.tagName = tagName.toUpperCase();
    this.ownerDocument = ownerDocument;
    this.children = [];
    this.parentNode = null;
    this.attributes = new Map();
    this.listeners = new Map();
    this.style = {};
    this.disabled = false;
    this.hidden = false;
    this._text = '';
  }

  set textContent(value) {
    for (const child of this.children) child.parentNode = null;
    this.children = [];
    this._text = String(value);
  }

  get textContent() {
    return this._text + this.children.map((child) => child.textContent).join('');
  }

  set innerHTML(_) {
    throw new Error('Release data must use textContent, never innerHTML');
  }

  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  append(...children) {
    children.forEach((child) => this.appendChild(child));
  }

  remove() {
    if (!this.parentNode) return;
    const siblings = this.parentNode.children;
    siblings.splice(siblings.indexOf(this), 1);
    this.parentNode = null;
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  addEventListener(name, handler) {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name).add(handler);
  }

  removeEventListener(name, handler) {
    this.listeners.get(name)?.delete(handler);
  }

  animate(keyframes, options) {
    const animation = { keyframes, options, cancelled: false, cancel() { this.cancelled = true; } };
    this.ownerDocument.animations.push(animation);
    return animation;
  }

  async click() {
    if (this.disabled) return;
    const event = { preventDefault() {}, stopPropagation() {} };
    await Promise.all([...this.listeners.get('click') ?? []].map((handler) => handler(event)));
  }
}

function documentFixture(reducedMotion = false) {
  const document = {
    createElement: (tag) => new Element(tag, document),
    animations: [],
    defaultView: { matchMedia: () => ({ matches: reducedMotion }) },
  };
  return document;
}

function descendants(root) {
  return [root, ...root.children.flatMap(descendants)];
}

function find(root, predicate) {
  const element = descendants(root).find(predicate);
  assert.ok(element, 'Expected page element was not rendered');
  return element;
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

function loadTweak(globals = {}) {
  assert.ok(fs.existsSync(entryPath), 'The Tweak entry has not been implemented');
  const context = { module: { exports: {} }, require: undefined, ...globals };
  vm.runInNewContext(fs.readFileSync(entryPath, 'utf8'), context, { filename: entryPath });
  assert.equal(typeof context.module.exports.start, 'function', 'The Tweak must export start');
  return context.module.exports;
}

function fakeClock(now = Date.now()) {
  let nextId = 0;
  const intervals = new Map();
  return {
    Date: { now: () => now },
    setInterval(callback, delay) { intervals.set(++nextId, { callback, delay, nextAt: now + delay }); return nextId; },
    clearInterval(id) { intervals.delete(id); },
    activeIntervals: () => intervals.size,
    advance(duration) {
      const target = now + duration;
      while (true) {
        const due = [...intervals.values()].filter((timer) => timer.nextAt <= target).sort((a, b) => a.nextAt - b.nextAt)[0];
        if (!due) break;
        now = due.nextAt;
        due.nextAt += due.delay;
        due.callback();
      }
      now = target;
    },
  };
}

const idleNativeState = { phase: 'idle', supported: true, message: null, version: null, startedAt: null };

function rendererFixture(invoke, readState = async () => idleNativeState, options = {}) {
  const document = documentFixture(options.reducedMotion);
  const clock = options.clock ?? fakeClock();
  const root = document.createElement('div');
  const registrations = [];
  const subscriptions = new Map();
  let unregisterCount = 0;
  const tweak = loadTweak({ document, Date: clock.Date, setInterval: clock.setInterval, clearInterval: clock.clearInterval });
  const api = {
    process: 'renderer',
    ipc: {
      invoke: (channel, ...args) => channel === 'get-native-update-state' ? readState() : invoke(channel, ...args),
      on(channel, listener) {
        if (!subscriptions.has(channel)) subscriptions.set(channel, new Set());
        subscriptions.get(channel).add(listener);
        return () => subscriptions.get(channel).delete(listener);
      },
    },
    settings: {
      registerPage(page) {
        registrations.push(page);
        return { unregister() { unregisterCount += 1; } };
      },
    },
  };
  tweak.start(api);
  return {
    tweak, root, registrations, subscriptions, clock, unregisterCount: () => unregisterCount,
    emit(state) { for (const listener of subscriptions.get('native-update-state') ?? []) listener(state); },
  };
}

test('renderer starts without Node require and reads only local version and native state on render', async () => {
  const calls = [];
  const fixture = rendererFixture(async (channel) => {
    calls.push(channel);
    return '2.26454.2.0';
  }, async () => { calls.push('get-native-update-state'); return idleNativeState; });
  assert.equal(fixture.registrations.length, 1);
  assert.equal(fixture.registrations[0].id, 'main');
  assert.equal(fixture.registrations[0].title, 'Claude 更新检查');
  assert.match(fixture.registrations[0].iconSvg, /<svg.*stroke="currentColor"/);
  assert.deepEqual(calls, []);

  const cleanup = fixture.registrations[0].render(fixture.root);
  await settle();
  assert.deepEqual(calls, ['get-version', 'get-native-update-state']);
  assert.match(fixture.root.textContent, /2\.26454\.2\.0/);
  assert.match(fixture.root.textContent, /点击.*更新 Claude.*下载/);
  assert.match(fixture.root.textContent, /下载完成后.*下次启动.*安装/);
  assert.equal(find(fixture.root, (node) => node.tagName === 'BUTTON').textContent, '检查更新（不下载）');
  assert.equal(find(fixture.root, (node) => node.tagName === 'BUTTON' && node.textContent === '更新 Claude').disabled, true);
  assert.equal(find(fixture.root, (node) => node.getAttribute('role') === 'status').getAttribute('aria-live'), 'polite');
  assert.equal(fixture.clock.activeIntervals(), 0);
  assert.equal(fixture.root.ownerDocument.animations.length, 0);
  cleanup();
});

test('manual checks show newer versions and render untrusted release notes as plain text', async () => {
  const pending = deferred();
  const calls = [];
  const notes = '<img src=x onerror=alert(1)>\nRelease & fixes';
  const fixture = rendererFixture((channel) => {
    calls.push(channel);
    return channel === 'get-version' ? Promise.resolve('2.26454.2.0') : pending.promise;
  });
  fixture.registrations[0].render(fixture.root);
  await settle();
  const button = find(fixture.root, (node) => node.tagName === 'BUTTON');
  const check = button.click();
  assert.equal(button.disabled, true);
  assert.equal(find(fixture.root, (node) => node.tagName === 'BUTTON' && node.textContent === '更新 Claude').disabled, true);
  await button.click();
  assert.deepEqual(calls, ['get-version', 'check-update']);

  pending.resolve({ currentVersion: '2.26454.2.0', latestVersion: '2.30000.0', updateAvailable: true, releaseNotes: notes });
  await check;
  assert.equal(button.disabled, false);
  assert.equal(find(fixture.root, (node) => node.tagName === 'BUTTON' && node.textContent === '更新 Claude').disabled, false);
  assert.match(fixture.root.textContent, /2\.30000\.0/);
  assert.match(find(fixture.root, (node) => node.getAttribute('role') === 'status').textContent, /发现新版本/);
  const renderedNotes = find(fixture.root, (node) => node.tagName === 'PRE');
  assert.equal(renderedNotes.textContent, notes);
  assert.equal(renderedNotes.children.length, 0);
  fixture.tweak.stop();
});

test('an empty release feed does not claim the installed version is up to date', async () => {
  const fixture = rendererFixture(async (channel) => channel === 'get-version' ? '2.26454.2.0' : {
    currentVersion: '2.26454.2.0', latestVersion: null, updateAvailable: false, releaseNotes: null,
  });
  fixture.registrations[0].render(fixture.root);
  await settle();
  await find(fixture.root, (node) => node.tagName === 'BUTTON').click();
  const status = find(fixture.root, (node) => node.getAttribute('role') === 'status');
  assert.match(status.textContent, /官方接口未返回新版信息/);
  assert.doesNotMatch(status.textContent, /已是最新|无需更新/);
  fixture.tweak.stop();
});

test('failed checks reset the button and clear a stale success result before retry', async () => {
  let checks = 0;
  const fixture = rendererFixture(async (channel) => {
    if (channel === 'get-version') return '2.26454.2.0';
    checks += 1;
    if (checks === 2) throw new Error('Network offline');
    return { currentVersion: '2.26454.2.0', latestVersion: '2.30000.0', updateAvailable: true, releaseNotes: 'First result' };
  });
  fixture.registrations[0].render(fixture.root);
  await settle();
  const button = find(fixture.root, (node) => node.tagName === 'BUTTON');
  await button.click();
  await button.click();
  const status = find(fixture.root, (node) => node.getAttribute('role') === 'status');
  assert.equal(button.disabled, false);
  assert.match(status.textContent, /检查失败/);
  assert.doesNotMatch(status.textContent, /已是最新|发现新版本/);
  assert.doesNotMatch(fixture.root.textContent, /First result|2\.30000\.0/);
  assert.equal(find(fixture.root, (node) => node.tagName === 'BUTTON' && node.textContent === '更新 Claude').disabled, true);
  await button.click();
  assert.equal(checks, 3);
  assert.match(status.textContent, /发现新版本/);
  fixture.tweak.stop();
});

test('page unmount removes its click listener and ignores late IPC results', async () => {
  const pending = deferred();
  const fixture = rendererFixture((channel) => channel === 'get-version' ? pending.promise : Promise.reject(new Error('Unexpected check')));
  const cleanup = fixture.registrations[0].render(fixture.root);
  const button = find(fixture.root, (node) => node.tagName === 'BUTTON');
  cleanup();
  assert.equal(button.listeners.get('click').size, 0);
  assert.equal(fixture.subscriptions.get('native-update-state').size, 0);
  assert.equal(fixture.root.children.length, 0);
  pending.resolve('9.9.9');
  await settle();
  assert.equal(fixture.root.children.length, 0);
  fixture.tweak.stop();
});

test('renderer stop unregisters the page and cleans every active view idempotently', async () => {
  const pending = deferred();
  const fixture = rendererFixture((channel) => channel === 'get-version' ? Promise.resolve('2.26454.2.0') : pending.promise);
  fixture.registrations[0].render(fixture.root);
  const secondRoot = fixture.root.ownerDocument.createElement('div');
  fixture.registrations[0].render(secondRoot);
  await settle();
  const button = find(fixture.root, (node) => node.tagName === 'BUTTON');
  const click = button.click();
  fixture.tweak.stop();
  fixture.tweak.stop();
  assert.equal(fixture.unregisterCount(), 1);
  assert.equal(button.listeners.get('click').size, 0);
  assert.equal(fixture.root.children.length, 0);
  assert.equal(secondRoot.children.length, 0);
  pending.resolve({ currentVersion: '2.26454.2.0', latestVersion: '9.9.9', updateAvailable: true, releaseNotes: 'Too late' });
  await click;
  assert.equal(fixture.root.children.length, 0);
});

function feedResponse(version = '2.30000.0') {
  return new Response(JSON.stringify({
    currentRelease: version,
    releases: [{
      version,
      updateTo: {
        name: `Claude ${version}`,
        version,
        pub_date: '2026-10-07T00:00:00Z',
        url: 'https://downloads.claude.ai/fixture-never-download.msix',
        notes: 'Production Release - No Notes',
      },
    }],
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

function mainFixture(request, values = new Map(), options = {}) {
  const calls = [];
  const storageReads = [];
  const storageWrites = [];
  const logs = [];
  const handlers = new Map();
  const nativeCalls = [];
  const messages = [];
  const dialogs = [];
  const externalUrls = [];
  const autoUpdater = new EventEmitter();
  autoUpdater.setFeedURL = (options) => nativeCalls.push({ method: 'setFeedURL', options });
  autoUpdater.checkForUpdates = () => { nativeCalls.push({ method: 'checkForUpdates' }); return options.nativeCheck?.(); };
  autoUpdater.quitAndInstall = () => nativeCalls.push({ method: 'quitAndInstall' });
  const net = {
    fetch(url, options) {
      assert.equal(this, net, 'Electron net.fetch must preserve its receiver');
      calls.push({ url: String(url), options });
      return request(url, options);
    },
  };
  const nodeRequire = createRequire(entryPath);
  const tweak = loadTweak({
    AbortController,
    process: { arch: 'x64', platform: 'win32', windowsStore: options.windowsStore ?? true, versions: { electron: '39.0.0' } },
    require: (name) => name === 'electron' ? {
      app: { getVersion: () => '2.26454.2.0' }, net, autoUpdater,
      dialog: { showMessageBox(dialogOptions) { dialogs.push(dialogOptions); return options.confirm?.() ?? Promise.resolve({ response: 0 }); } },
      shell: { openExternal(url) { externalUrls.push(url); return options.openExternal?.(url) ?? Promise.resolve(); } },
    } : nodeRequire(name),
  });
  const api = {
    process: 'main',
    ipc: {
      handle(channel, handler) { handlers.set(channel, handler); },
      send(channel, value) { messages.push({ channel, value }); },
    },
    storage: {
      get(key) { storageReads.push(key); return values.get(key); },
      set(key, value) { storageWrites.push([key, value]); values.set(key, value); },
    },
    log: { info(...args) { logs.push(args); } },
  };
  tweak.start(api);
  return { tweak, handlers, calls, storageReads, storageWrites, values, logs, nativeCalls, messages, dialogs, autoUpdater, externalUrls };
}

function mainHandler(fixture, channel) {
  const handler = fixture.handlers.get(channel);
  assert.equal(typeof handler, 'function', `Missing Main IPC handler: ${channel}`);
  return handler;
}

test('Main startup and local version reads never query the network or create an identity', async () => {
  const fixture = mainFixture(() => { throw new Error('Unexpected network request'); });
  assert.equal(await mainHandler(fixture, 'get-version')(), '2.26454.2.0');
  mainHandler(fixture, 'check-update');
  assert.equal(mainHandler(fixture, 'get-native-update-state')().phase, 'idle');
  await settle();
  assert.equal(fixture.calls.length, 0);
  assert.deepEqual(fixture.storageReads, []);
  assert.deepEqual(fixture.storageWrites, []);
  assert.deepEqual(fixture.nativeCalls, []);
  assert.deepEqual(fixture.externalUrls, []);
  assert.match(fixture.logs.flat().join(' '), /2\.26454\.2\.0/);
  fixture.tweak.stop();
});

test('an explicit Main check creates one synthetic identity and reuses it across restarts', async () => {
  const fixture = mainFixture(async () => feedResponse());
  const result = await mainHandler(fixture, 'check-update')();
  assert.equal(result.currentVersion, '2.26454.2.0');
  assert.equal(result.latestVersion, '2.30000.0');
  assert.equal(result.updateAvailable, true);
  assert.equal(fixture.calls.length, 1);
  assert.deepEqual(fixture.externalUrls, [], 'Metadata checks must not open the release notes page');
  assert.equal(fixture.storageWrites.length, 1);
  const [key, identity] = fixture.storageWrites[0];
  assert.equal(key, 'deviceId');
  assert.match(identity, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  assert.equal(new URL(fixture.calls[0].url).searchParams.get('device_id'), identity);
  const log = fixture.logs.flat().join(' ');
  assert.match(log, /2\.26454\.2\.0/);
  assert.match(log, /2\.30000\.0/);
  assert.ok(!log.includes(identity));
  assert.doesNotMatch(log, /https?:\/\//);
  fixture.tweak.stop();

  const restarted = mainFixture(async () => feedResponse(), fixture.values);
  await mainHandler(restarted, 'check-update')();
  assert.equal(restarted.storageWrites.length, 0);
  assert.equal(new URL(restarted.calls[0].url).searchParams.get('device_id'), identity);
  restarted.tweak.stop();
});

test('simultaneous Main checks share one metadata request', async () => {
  const pending = deferred();
  const fixture = mainFixture(() => pending.promise);
  const check = mainHandler(fixture, 'check-update');
  const first = check();
  const second = check();
  await settle();
  assert.equal(fixture.calls.length, 1);
  assert.equal(fixture.storageWrites.length, 1);
  pending.resolve(feedResponse());
  const results = await Promise.all([first, second]);
  assert.equal(results[0].latestVersion, '2.30000.0');
  assert.equal(results[1].latestVersion, '2.30000.0');
  fixture.tweak.stop();
});

test('a failed Main check rejects and releases the pending request for retry', async () => {
  let attempts = 0;
  const fixture = mainFixture(async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('Offline');
    return feedResponse();
  });
  const check = mainHandler(fixture, 'check-update');
  await assert.rejects(check(), /Offline/);
  const result = await check();
  assert.equal(result.updateAvailable, true);
  assert.equal(fixture.calls.length, 2);
  assert.equal(fixture.storageWrites.length, 1);
  fixture.tweak.stop();
});

test('Main stop aborts an in-flight query and prevents retained IPC handlers from checking again', async () => {
  let requestSignal;
  const fixture = mainFixture((_url, options) => {
    requestSignal = options.signal;
    return new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
    });
  });
  const check = mainHandler(fixture, 'check-update');
  const getVersion = mainHandler(fixture, 'get-version');
  const checking = check();
  const rejected = assert.rejects(checking);
  await settle();
  fixture.tweak.stop();
  fixture.tweak.stop();
  assert.equal(requestSignal.aborted, true);
  await rejected;
  assert.throws(() => check(), /stopped|停止|停用/i);
  assert.throws(() => getVersion(), /stopped|停止|停用/i);
  assert.equal(fixture.calls.length, 1);
});

test('a renderer IPC timeout is shown in Chinese and leaves the manual check available', async () => {
  const fixture = rendererFixture(async (channel) => {
    if (channel === 'get-version') return '2.26454.2.0';
    throw new Error('IPC invoke timeout');
  });
  fixture.registrations[0].render(fixture.root);
  await settle();
  const button = find(fixture.root, (node) => node.tagName === 'BUTTON');
  await button.click();
  assert.equal(button.disabled, false);
  assert.match(find(fixture.root, (node) => node.getAttribute('role') === 'status').textContent, /检查超时/);
  fixture.tweak.stop();
});

test('the official placeholder for empty release notes is explained without inventing changes', async () => {
  const fixture = rendererFixture(async (channel) => channel === 'get-version' ? '2.26454.2.0' : {
    currentVersion: '2.26454.2.0', latestVersion: '2.26454.2', updateAvailable: false, releaseNotes: 'Production Release - No Notes',
  });
  fixture.registrations[0].render(fixture.root);
  await settle();
  await find(fixture.root, (node) => node.tagName === 'BUTTON').click();
  assert.match(find(fixture.root, (node) => node.getAttribute('role') === 'status').textContent, /当前版本无需更新/);
  assert.equal(find(fixture.root, (node) => node.tagName === 'PRE').textContent, '此版本接口未提供详细更新说明。');
  fixture.tweak.stop();
});

test('only an explicit update click starts native work and native events keep both actions disabled', async () => {
  const calls = [];
  const fixture = rendererFixture(async (channel) => {
    calls.push(channel);
    if (channel === 'get-version') return '2.26454.2.0';
    if (channel === 'check-update') return { currentVersion: '2.26454.2.0', latestVersion: '2.30000.0', updateAvailable: true, releaseNotes: null };
    if (channel === 'start-native-update') return { ...idleNativeState, phase: 'checking' };
    throw new Error(`Unexpected invocation ${channel}`);
  });
  fixture.registrations[0].render(fixture.root);
  await settle();
  const check = find(fixture.root, (node) => node.tagName === 'BUTTON' && node.textContent.includes('检查更新'));
  const update = find(fixture.root, (node) => node.tagName === 'BUTTON' && node.textContent === '更新 Claude');
  await check.click();
  assert.deepEqual(calls, ['get-version', 'check-update']);
  await update.click();
  assert.deepEqual(calls, ['get-version', 'check-update', 'start-native-update']);
  assert.equal(check.disabled, true);
  assert.equal(update.disabled, true);
  assert.match(find(fixture.root, (node) => node.getAttribute('role') === 'status').textContent, /检查|查询/);
  fixture.emit({ ...idleNativeState, phase: 'downloading' });
  assert.match(find(fixture.root, (node) => node.getAttribute('role') === 'status').textContent, /下载/);
  const activity = find(fixture.root, (node) => node.getAttribute('aria-label') === '原生更新活动');
  assert.equal(activity.hidden, false);
  assert.equal(descendants(fixture.root).some((node) => node.tagName === 'PROGRESS' || node.getAttribute('aria-valuenow') !== null), false);
  assert.match(fixture.root.textContent, /原生更新器不提供百分比/);
  await check.click();
  await update.click();
  assert.equal(calls.length, 3);
  fixture.emit({ ...idleNativeState, phase: 'ready', version: '2.30000.0' });
  assert.equal(update.textContent, '重启安装');
  assert.equal(update.disabled, false);
  assert.equal(activity.hidden, true);
  fixture.tweak.stop();
});

test('a page opened after download offers only the explicit restart action', async () => {
  const calls = [];
  const ready = { ...idleNativeState, phase: 'ready', version: '2.30000.0' };
  const fixture = rendererFixture(async (channel) => {
    calls.push(channel);
    if (channel === 'get-version') return '2.26454.2.0';
    if (channel === 'restart-native-update') return ready;
    throw new Error(`Unexpected invocation ${channel}`);
  }, async () => ready);
  fixture.registrations[0].render(fixture.root);
  await settle();
  assert.deepEqual(calls, ['get-version']);
  const update = find(fixture.root, (node) => node.tagName === 'BUTTON' && node.textContent === '重启安装');
  assert.equal(update.disabled, false);
  assert.match(fixture.root.textContent, /2\.30000\.0/);
  await update.click();
  assert.deepEqual(calls, ['get-version', 'restart-native-update']);
  assert.equal(update.disabled, false, 'Cancelling confirmation retains the restart action');
  fixture.emit({ ...ready, phase: 'restarting' });
  assert.equal(update.disabled, true);
  assert.equal(find(fixture.root, (node) => node.tagName === 'BUTTON' && node.textContent.includes('检查更新')).disabled, true);
  fixture.tweak.stop();
});

test('confirmation waiting disables both actions without claiming installation has started', async () => {
  const ready = { ...idleNativeState, phase: 'ready', version: '2.30000.0' };
  const fixture = rendererFixture(async (channel) => {
    if (channel === 'get-version') return '2.26454.2.0';
    assert.equal(channel, 'restart-native-update');
    return { ...ready, phase: 'confirming' };
  }, async () => ready);
  fixture.registrations[0].render(fixture.root);
  await settle();
  const update = find(fixture.root, (node) => node.tagName === 'BUTTON' && node.textContent === '重启安装');
  const check = find(fixture.root, (node) => node.tagName === 'BUTTON' && node.textContent.includes('检查更新'));
  await update.click();
  assert.equal(update.disabled, true);
  assert.equal(check.disabled, true);
  assert.match(find(fixture.root, (node) => node.getAttribute('role') === 'status').textContent, /确认对话框/);
  assert.doesNotMatch(find(fixture.root, (node) => node.getAttribute('role') === 'status').textContent, /正在重启|安装更新/);
  fixture.emit(ready);
  assert.equal(update.textContent, '重启安装');
  assert.equal(update.disabled, false);
  fixture.tweak.stop();
});

test('unsupported native updates show the reason even after metadata finds a newer version', async () => {
  const reason = '<img src=x onerror=alert(1)> 当前安装方式不支持原生更新';
  const fixture = rendererFixture(async (channel) => channel === 'get-version' ? '2.26454.2.0' : {
    currentVersion: '2.26454.2.0', latestVersion: '2.30000.0', updateAvailable: true, releaseNotes: null,
  }, async () => ({ phase: 'unavailable', supported: false, message: reason, version: null }));
  fixture.registrations[0].render(fixture.root);
  await settle();
  await find(fixture.root, (node) => node.tagName === 'BUTTON' && node.textContent.includes('检查更新')).click();
  assert.match(fixture.root.textContent, /发现新版本/);
  assert.ok(fixture.root.textContent.includes(reason));
  assert.equal(find(fixture.root, (node) => node.tagName === 'BUTTON' && node.textContent === '更新 Claude').disabled, true);
  fixture.tweak.stop();
});

test('late state reads and action snapshots cannot overwrite newer native event state', async () => {
  const initial = deferred();
  const start = deferred();
  const fixture = rendererFixture(async (channel) => {
    if (channel === 'get-version') return '2.26454.2.0';
    if (channel === 'check-update') return { currentVersion: '2.26454.2.0', latestVersion: '2.30000.0', updateAvailable: true, releaseNotes: null };
    if (channel === 'start-native-update') return start.promise;
    throw new Error(`Unexpected invocation ${channel}`);
  }, () => initial.promise);
  fixture.registrations[0].render(fixture.root);
  await settle();
  fixture.emit(idleNativeState);
  await find(fixture.root, (node) => node.tagName === 'BUTTON' && node.textContent.includes('检查更新')).click();
  const update = find(fixture.root, (node) => node.tagName === 'BUTTON' && node.textContent === '更新 Claude');
  const click = update.click();
  fixture.emit({ ...idleNativeState, phase: 'ready', version: '2.30000.0' });
  initial.resolve(idleNativeState);
  start.resolve({ ...idleNativeState, phase: 'checking' });
  await click;
  await settle();
  assert.equal(update.textContent, '重启安装');
  assert.equal(update.disabled, false);
  fixture.tweak.stop();
});

test('finishing a metadata check cannot unlock actions while a native download is active', async () => {
  const metadata = deferred();
  const fixture = rendererFixture(async (channel) => channel === 'get-version' ? '2.26454.2.0' : metadata.promise);
  fixture.registrations[0].render(fixture.root);
  await settle();
  const check = find(fixture.root, (node) => node.tagName === 'BUTTON' && node.textContent.includes('检查更新'));
  const update = find(fixture.root, (node) => node.tagName === 'BUTTON' && node.textContent === '更新 Claude');
  const checking = check.click();
  fixture.emit({ ...idleNativeState, phase: 'downloading' });
  metadata.resolve({ currentVersion: '2.26454.2.0', latestVersion: '2.30000.0', updateAvailable: true, releaseNotes: null });
  await checking;
  assert.equal(check.disabled, true);
  assert.equal(update.disabled, true);
  assert.match(find(fixture.root, (node) => node.getAttribute('role') === 'status').textContent, /下载/);
  fixture.tweak.stop();
});

test('all open views share native updates and one view cleanup leaves the other subscribed', async () => {
  const fixture = rendererFixture(async (channel) => {
    assert.equal(channel, 'get-version');
    return '2.26454.2.0';
  });
  const cleanup = fixture.registrations[0].render(fixture.root);
  const second = fixture.root.ownerDocument.createElement('div');
  fixture.registrations[0].render(second);
  await settle();
  fixture.emit({ ...idleNativeState, phase: 'downloading' });
  for (const root of [fixture.root, second]) {
    assert.equal(find(root, (node) => node.tagName === 'BUTTON' && node.textContent.includes('检查更新')).disabled, true);
    assert.match(find(root, (node) => node.getAttribute('role') === 'status').textContent, /下载/);
  }
  cleanup();
  fixture.emit({ ...idleNativeState, phase: 'ready', version: '2.30000.0' });
  assert.equal(fixture.root.children.length, 0);
  assert.equal(find(second, (node) => node.tagName === 'BUTTON' && node.textContent === '重启安装').disabled, false);
  assert.equal(fixture.subscriptions.get('native-update-state').size, 1);
  fixture.tweak.stop();
});

test('native errors are plain text and leave manual retry available only with a newer metadata result', async () => {
  const reason = '<script>throw Error()</script> 下载失败';
  const fixture = rendererFixture(async (channel) => {
    if (channel === 'get-version') return '2.26454.2.0';
    if (channel === 'check-update') return { currentVersion: '2.26454.2.0', latestVersion: '2.30000.0', updateAvailable: true, releaseNotes: null };
    throw new Error(reason);
  });
  const cleanup = fixture.registrations[0].render(fixture.root);
  await settle();
  const check = find(fixture.root, (node) => node.tagName === 'BUTTON' && node.textContent.includes('检查更新'));
  const update = find(fixture.root, (node) => node.tagName === 'BUTTON' && node.textContent === '更新 Claude');
  await check.click();
  await update.click();
  assert.ok(fixture.root.textContent.includes(reason));
  assert.equal(update.disabled, false);
  const status = find(fixture.root, (node) => node.getAttribute('role') === 'status');
  const before = status.textContent;
  cleanup();
  fixture.emit({ ...idleNativeState, phase: 'downloading' });
  assert.equal(status.textContent, before);
  assert.equal(update.listeners.get('click').size, 0);
  assert.equal(fixture.subscriptions.get('native-update-state').size, 0);
  assert.equal(fixture.root.children.length, 0);
  fixture.tweak.stop();
});

test('a later manual metadata check replaces an idle native no-update message with its own result or failure', async () => {
  const metadata = deferred();
  let attempts = 0;
  const fixture = rendererFixture(async (channel) => {
    if (channel === 'get-version') return '2.26454.2.0';
    assert.equal(channel, 'check-update');
    attempts += 1;
    if (attempts === 1) return metadata.promise;
    throw new Error('Offline');
  });
  fixture.registrations[0].render(fixture.root);
  await settle();
  const check = find(fixture.root, (node) => node.tagName === 'BUTTON' && node.textContent.includes('检查更新'));
  const update = find(fixture.root, (node) => node.tagName === 'BUTTON' && node.textContent === '更新 Claude');
  const status = find(fixture.root, (node) => node.getAttribute('role') === 'status');
  fixture.emit({ ...idleNativeState, message: '当前版本无需更新。' });
  assert.match(status.textContent, /无需更新/);
  const checking = check.click();
  assert.match(status.textContent, /正在查询/);
  metadata.resolve({ currentVersion: '2.26454.2.0', latestVersion: '2.30000.0', updateAvailable: true, releaseNotes: null });
  await checking;
  assert.match(status.textContent, /发现新版本/);
  assert.doesNotMatch(status.textContent, /无需更新/);
  assert.equal(update.disabled, false);
  await check.click();
  assert.match(status.textContent, /检查失败/);
  assert.doesNotMatch(status.textContent, /无需更新/);
  assert.equal(update.disabled, true);
  fixture.tweak.stop();
});

test('a manual metadata result replaces an earlier native error and a fresh native error remains visible', async () => {
  const metadata = deferred();
  const fixture = rendererFixture(async (channel) => channel === 'get-version' ? '2.26454.2.0' : metadata.promise);
  fixture.registrations[0].render(fixture.root);
  await settle();
  fixture.emit({ ...idleNativeState, phase: 'error', message: '上次下载失败。' });
  const status = find(fixture.root, (node) => node.getAttribute('role') === 'status');
  assert.match(status.textContent, /上次下载失败/);
  const checking = find(fixture.root, (node) => node.tagName === 'BUTTON' && node.textContent.includes('检查更新')).click();
  assert.match(status.textContent, /正在查询/);
  metadata.resolve({ currentVersion: '2.26454.2.0', latestVersion: '2.30000.0', updateAvailable: true, releaseNotes: null });
  await checking;
  assert.match(status.textContent, /发现新版本/);
  assert.doesNotMatch(status.textContent, /上次下载失败/);
  assert.equal(find(fixture.root, (node) => node.tagName === 'BUTTON' && node.textContent === '更新 Claude').disabled, false);
  fixture.emit({ ...idleNativeState, phase: 'error', message: '新的下载错误。' });
  assert.match(status.textContent, /新的下载错误/);
  fixture.tweak.stop();
});

test('a failed manual metadata check replaces an earlier native error and disables update', async () => {
  const metadata = deferred();
  const fixture = rendererFixture(async (channel) => channel === 'get-version' ? '2.26454.2.0' : metadata.promise);
  fixture.registrations[0].render(fixture.root);
  await settle();
  fixture.emit({ ...idleNativeState, phase: 'error', message: '上次下载失败。' });
  const status = find(fixture.root, (node) => node.getAttribute('role') === 'status');
  const checking = find(fixture.root, (node) => node.tagName === 'BUTTON' && node.textContent.includes('检查更新')).click();
  assert.match(status.textContent, /正在查询/);
  metadata.reject(new Error('Offline'));
  await checking;
  assert.match(status.textContent, /检查失败/);
  assert.doesNotMatch(status.textContent, /上次下载失败/);
  assert.equal(find(fixture.root, (node) => node.tagName === 'BUTTON' && node.textContent === '更新 Claude').disabled, true);
  assert.equal(find(fixture.root, (node) => node.tagName === 'BUTTON' && node.textContent.includes('检查更新')).disabled, false);
  fixture.tweak.stop();
});

test('a late initial idle snapshot preserves the newer manual metadata result', async () => {
  const initial = deferred();
  const fixture = rendererFixture(async (channel) => channel === 'get-version' ? '2.26454.2.0' : {
    currentVersion: '2.26454.2.0', latestVersion: '2.30000.0', updateAvailable: true, releaseNotes: null,
  }, () => initial.promise);
  fixture.registrations[0].render(fixture.root);
  await settle();
  await find(fixture.root, (node) => node.tagName === 'BUTTON' && node.textContent.includes('检查更新')).click();
  initial.resolve({ ...idleNativeState, message: '当前版本无需更新。' });
  await settle();
  const status = find(fixture.root, (node) => node.getAttribute('role') === 'status');
  assert.match(status.textContent, /发现新版本/);
  assert.doesNotMatch(status.textContent, /无需更新/);
  assert.equal(find(fixture.root, (node) => node.tagName === 'BUTTON' && node.textContent === '更新 Claude').disabled, false);
  fixture.tweak.stop();
});

test('a late initial error snapshot preserves the completed manual metadata result', async () => {
  const initial = deferred();
  const fixture = rendererFixture(async (channel) => channel === 'get-version' ? '2.26454.2.0' : {
    currentVersion: '2.26454.2.0', latestVersion: '2.30000.0', updateAvailable: true, releaseNotes: null,
  }, () => initial.promise);
  fixture.registrations[0].render(fixture.root);
  await settle();
  await find(fixture.root, (node) => node.tagName === 'BUTTON' && node.textContent.includes('检查更新')).click();
  initial.resolve({ ...idleNativeState, phase: 'error', message: '上次下载失败。' });
  await settle();
  const status = find(fixture.root, (node) => node.getAttribute('role') === 'status');
  assert.match(status.textContent, /发现新版本/);
  assert.doesNotMatch(status.textContent, /上次下载失败/);
  assert.equal(find(fixture.root, (node) => node.tagName === 'BUTTON' && node.textContent === '更新 Claude').disabled, false);
  fixture.emit({ ...idleNativeState, phase: 'error', message: '新的下载错误。' });
  assert.match(status.textContent, /新的下载错误/);
  fixture.tweak.stop();
});

test('Main rejects native start until a successful current metadata result is newer', async () => {
  let response = feedResponse('2.26454.2');
  const fixture = mainFixture(async () => response);
  const start = mainHandler(fixture, 'start-native-update');
  assert.throws(() => start('https://example.invalid/feed', '99.0.0'), /检查|新版本/);
  await mainHandler(fixture, 'check-update')();
  assert.throws(() => start(), /检查|新版本/);
  assert.deepEqual(fixture.nativeCalls, []);
  response = feedResponse();
  await mainHandler(fixture, 'check-update')();
  const state = start('https://example.invalid/feed', '99.0.0');
  assert.equal(state.phase, 'checking');
  assert.deepEqual(fixture.nativeCalls.map((call) => call.method), ['setFeedURL', 'checkForUpdates']);
  const nativeUrl = new URL(fixture.nativeCalls[0].options.url);
  assert.equal(nativeUrl.origin, 'https://api.anthropic.com');
  assert.equal(nativeUrl.pathname, '/api/desktop/win32/x64/msix/update');
  assert.equal(nativeUrl.searchParams.get('version'), '2.26454.2.0');
  assert.equal(nativeUrl.searchParams.get('device_id'), fixture.values.get('deviceId'));
  assert.equal(fixture.storageWrites.length, 1);
  assert.equal(mainHandler(fixture, 'start-native-update')().phase, 'checking');
  assert.equal(fixture.nativeCalls.length, 2);
  assert.throws(() => mainHandler(fixture, 'check-update')(), /正在|等待|更新/);
  fixture.autoUpdater.emit('update-available');
  assert.equal(mainHandler(fixture, 'get-native-update-state')().phase, 'downloading');
  assert.equal(fixture.messages.at(-1).channel, 'native-update-state');
  assert.equal(fixture.messages.at(-1).value.phase, 'downloading');
  fixture.autoUpdater.emit('update-downloaded', {}, 'Release notes', '2.30000.0', new Date(), 'https://example.invalid/ignored');
  assert.equal(mainHandler(fixture, 'start-native-update')().phase, 'ready');
  assert.equal(fixture.nativeCalls.length, 2, 'A downloaded update must not download again');
  fixture.tweak.stop();
});

test('Main clears stale metadata eligibility when rechecking and after failure', async () => {
  const pending = deferred();
  let attempts = 0;
  const fixture = mainFixture(() => { attempts += 1; return attempts === 1 ? feedResponse() : pending.promise; });
  await mainHandler(fixture, 'check-update')();
  const checking = mainHandler(fixture, 'check-update')();
  assert.throws(() => mainHandler(fixture, 'start-native-update')(), /检查|新版本/);
  pending.reject(new Error('Offline'));
  await assert.rejects(checking, /Offline/);
  assert.throws(() => mainHandler(fixture, 'start-native-update')(), /检查|新版本/);
  assert.deepEqual(fixture.nativeCalls, []);
  fixture.tweak.stop();
});

test('Main native restart requires a cancel-default dialog and ignores confirmation after stop', async () => {
  const confirmation = deferred();
  const fixture = mainFixture(async () => feedResponse(), new Map(), { confirm: () => confirmation.promise });
  await mainHandler(fixture, 'check-update')();
  mainHandler(fixture, 'start-native-update')();
  fixture.autoUpdater.emit('update-downloaded', {}, '', '2.30000.0');
  const restart = mainHandler(fixture, 'restart-native-update');
  const acknowledgement = restart();
  assert.equal(typeof acknowledgement.then, 'undefined', 'The IPC reply must not wait for the user dialog');
  assert.equal(acknowledgement.phase, 'confirming');
  assert.throws(() => mainHandler(fixture, 'check-update')(), /正在|等待|更新/);
  await settle();
  assert.equal(fixture.dialogs.length, 1);
  const dialog = fixture.dialogs[0];
  assert.deepEqual([...dialog.buttons], ['取消', '重启并安装']);
  assert.equal(dialog.defaultId, 0);
  assert.equal(dialog.cancelId, 0);
  assert.match(`${dialog.message} ${dialog.detail}`, /关闭.*Claude.*窗口/);
  assert.match(`${dialog.message} ${dialog.detail}`, /任务/);
  assert.match(`${dialog.message} ${dialog.detail}`, /下次|下一次/);
  fixture.tweak.stop();
  const messageCount = fixture.messages.length;
  confirmation.resolve({ response: 1 });
  await settle();
  assert.equal(fixture.nativeCalls.filter((call) => call.method === 'quitAndInstall').length, 0);
  fixture.autoUpdater.emit('update-downloaded', {}, '', '2.40000.0');
  assert.equal(fixture.messages.length, messageCount);
  for (const channel of ['get-native-update-state', 'start-native-update', 'restart-native-update']) {
    assert.throws(() => mainHandler(fixture, channel)(), /stopped|停止|停用/i);
  }
});

test('Main cancel keeps downloaded state and explicit confirmation calls install once', async () => {
  let response = 0;
  const fixture = mainFixture(async () => feedResponse(), new Map(), { confirm: async () => ({ response }) });
  await mainHandler(fixture, 'check-update')();
  mainHandler(fixture, 'start-native-update')();
  fixture.autoUpdater.emit('update-downloaded', {}, '', '2.30000.0');
  const restart = mainHandler(fixture, 'restart-native-update');
  assert.equal(restart().phase, 'confirming');
  await settle();
  assert.equal(mainHandler(fixture, 'get-native-update-state')().phase, 'ready');
  assert.equal(fixture.nativeCalls.filter((call) => call.method === 'quitAndInstall').length, 0);
  response = 1;
  const first = restart();
  const second = restart();
  assert.equal(first.phase, 'confirming');
  assert.equal(second.phase, 'confirming');
  await settle();
  assert.equal(mainHandler(fixture, 'get-native-update-state')().phase, 'restarting');
  assert.equal(fixture.dialogs.length, 2);
  assert.equal(fixture.nativeCalls.filter((call) => call.method === 'quitAndInstall').length, 1);
  fixture.tweak.stop();
});

test('download activity animates and waiting time ticks from the Main start time without a made-up percentage', async () => {
  const clock = fakeClock(100_000);
  const calls = [];
  const fixture = rendererFixture(async (channel) => { calls.push(channel); return '2.26454.2.0'; }, async () => ({
    ...idleNativeState, phase: 'checking', startedAt: 90_000,
  }), { clock });
  fixture.registrations[0].render(fixture.root);
  await settle();
  const activity = find(fixture.root, (node) => node.getAttribute('aria-label') === '原生更新活动');
  const elapsed = find(activity, (node) => node.getAttribute('aria-label') === '更新等待时长');
  const status = find(fixture.root, (node) => node.getAttribute('role') === 'status');
  assert.equal(activity.hidden, false);
  assert.doesNotMatch(activity.style.cssText, /(?:^|;)\s*display\s*:/i, 'Inline display must not override the hidden attribute');
  assert.match(elapsed.textContent, /10 秒/);
  assert.equal(elapsed.getAttribute('aria-live'), 'off');
  assert.equal(clock.activeIntervals(), 1);
  const animation = fixture.root.ownerDocument.animations[0];
  assert.ok(animation);
  assert.notEqual(animation.keyframes[0].transform, animation.keyframes.at(-1).transform);
  assert.equal(animation.options.iterations, Infinity);
  clock.advance(1000);
  assert.match(elapsed.textContent, /11 秒/);
  fixture.emit({ ...idleNativeState, phase: 'downloading', startedAt: 90_000 });
  assert.match(status.textContent, /Windows 正在下载并准备更新/);
  assert.match(fixture.root.textContent, /原生更新器不提供百分比/);
  assert.equal(fixture.root.ownerDocument.animations.length, 1);
  assert.equal(clock.activeIntervals(), 1);
  assert.equal(descendants(fixture.root).some((node) => node.tagName === 'PROGRESS' || node.getAttribute('aria-valuenow') !== null), false);
  const stage = status.textContent;
  clock.advance(109_000);
  assert.equal(status.textContent, stage, 'Elapsed time does not trigger per-second live announcements');
  assert.match(elapsed.textContent, /120 秒/);
  assert.match(activity.textContent, /尚未收到完成或错误反馈，无法判断是否停滞/);
  assert.deepEqual(calls, ['get-version'], 'A long wait never retries or initiates work');
  fixture.emit({ ...idleNativeState, phase: 'ready', startedAt: 90_000 });
  assert.equal(activity.hidden, true);
  assert.equal(clock.activeIntervals(), 0);
  assert.equal(animation.cancelled, true);
  fixture.tweak.stop();
});

test('reopening a download uses its original start time and unknown start time remains unknown', async () => {
  const clock = fakeClock(500_000);
  const restored = { ...idleNativeState, phase: 'downloading', startedAt: 420_000 };
  const fixture = rendererFixture(async () => '2.26454.2.0', async () => restored, { clock });
  const cleanup = fixture.registrations[0].render(fixture.root);
  await settle();
  assert.match(fixture.root.textContent, /80 秒/);
  cleanup();
  assert.equal(clock.activeIntervals(), 0);
  clock.advance(5000);
  fixture.registrations[0].render(fixture.root);
  await settle();
  assert.match(fixture.root.textContent, /85 秒/);
  fixture.emit({ ...restored, startedAt: null });
  const elapsed = find(fixture.root, (node) => node.getAttribute('aria-label') === '更新等待时长');
  assert.match(elapsed.textContent, /无法获取开始时间/);
  clock.advance(200_000);
  assert.match(elapsed.textContent, /无法获取开始时间/);
  assert.doesNotMatch(fixture.root.textContent, /无法判断是否停滞/);
  fixture.tweak.stop();
  assert.equal(clock.activeIntervals(), 0);
  assert.ok(fixture.root.ownerDocument.animations.every((animation) => animation.cancelled));
});

test('terminal states and cleanup stop activity while restarting does not count time spent ready', async () => {
  const clock = fakeClock(10_000_000);
  const fixture = rendererFixture(async () => '2.26454.2.0', async () => idleNativeState, { clock });
  const cleanup = fixture.registrations[0].render(fixture.root);
  await settle();
  const activity = find(fixture.root, (node) => node.getAttribute('aria-label') === '原生更新活动');
  for (const phase of ['confirming', 'ready', 'error', 'idle', 'unavailable']) {
    fixture.emit({ ...idleNativeState, phase: 'downloading', startedAt: 0 });
    assert.equal(clock.activeIntervals(), 1);
    fixture.emit({ ...idleNativeState, phase, startedAt: 0 });
    assert.equal(activity.hidden, true);
    assert.equal(clock.activeIntervals(), 0);
    assert.equal(fixture.root.ownerDocument.animations.at(-1).cancelled, true);
  }
  fixture.emit({ ...idleNativeState, phase: 'restarting', startedAt: 0 });
  assert.equal(activity.hidden, false);
  assert.equal(clock.activeIntervals(), 0);
  assert.doesNotMatch(activity.textContent, /秒|无法判断是否停滞/);
  assert.equal(fixture.root.ownerDocument.animations.at(-1).cancelled, false);
  cleanup();
  assert.equal(fixture.root.ownerDocument.animations.at(-1).cancelled, true);
  fixture.emit({ ...idleNativeState, phase: 'downloading', startedAt: 0 });
  assert.equal(clock.activeIntervals(), 0);
  fixture.tweak.stop();
});

test('reduced motion suppresses moving activity while elapsed time still updates', async () => {
  const clock = fakeClock(50_000);
  const fixture = rendererFixture(async () => '2.26454.2.0', async () => ({
    ...idleNativeState, phase: 'downloading', startedAt: 40_000,
  }), { clock, reducedMotion: true });
  fixture.registrations[0].render(fixture.root);
  await settle();
  assert.equal(fixture.root.ownerDocument.animations.length, 0);
  assert.match(fixture.root.textContent, /10 秒/);
  clock.advance(1000);
  assert.match(fixture.root.textContent, /11 秒/);
  fixture.tweak.stop();
  assert.equal(clock.activeIntervals(), 0);
});

for (const releaseNotes of [null, '', '  \n\t', 'Production Release - No Notes', '  production RELEASE - NO notes  ']) {
  test(`a successful version result explains missing detailed notes: ${JSON.stringify(releaseNotes)}`, async () => {
    const calls = [];
    const fixture = rendererFixture(async (channel) => {
      calls.push(channel);
      return channel === 'get-version' ? '2.26454.2.0' : {
        currentVersion: '2.26454.2.0', latestVersion: '2.30000.0', updateAvailable: true, releaseNotes,
      };
    });
    fixture.registrations[0].render(fixture.root);
    await settle();
    await find(fixture.root, (node) => node.tagName === 'BUTTON' && node.textContent.includes('检查更新')).click();
    const notes = find(fixture.root, (node) => node.tagName === 'PRE');
    assert.equal(notes.parentNode.hidden, false);
    assert.equal(notes.textContent, '此版本接口未提供详细更新说明。');
    assert.match(fixture.root.textContent, /产品整体.*安装包/);
    assert.deepEqual(calls, ['get-version', 'check-update']);
    fixture.tweak.stop();
  });
}

test('the official notes action opens only on click and shows failure without changing update status', async () => {
  const calls = [];
  const opened = deferred();
  const fixture = rendererFixture(async (channel) => {
    calls.push(channel);
    if (channel === 'get-version') return '2.26454.2.0';
    assert.equal(channel, 'open-release-notes');
    return opened.promise;
  });
  const cleanup = fixture.registrations[0].render(fixture.root);
  await settle();
  assert.deepEqual(calls, ['get-version']);
  const button = find(fixture.root, (node) => node.tagName === 'BUTTON' && node.textContent === '查看官方产品更新记录');
  const nativeStatus = find(fixture.root, (node) => node.getAttribute('role') === 'status');
  const before = nativeStatus.textContent;
  const click = button.click();
  assert.equal(button.disabled, true);
  await button.click();
  opened.reject(new Error('<script>External blocked</script>'));
  await click;
  assert.deepEqual(calls, ['get-version', 'open-release-notes']);
  assert.equal(button.disabled, false);
  assert.match(fixture.root.textContent, /无法打开官方产品更新记录/);
  assert.equal(nativeStatus.textContent, before);
  cleanup();
  assert.equal(button.listeners.get('click').size, 0);
  assert.equal(fixture.root.children.length, 0);
  fixture.tweak.stop();
});

test('unmount ignores a late official notes error and releases its click listener', async () => {
  const opened = deferred();
  const fixture = rendererFixture(async (channel) => channel === 'get-version' ? '2.26454.2.0' : opened.promise);
  const cleanup = fixture.registrations[0].render(fixture.root);
  await settle();
  const button = find(fixture.root, (node) => node.tagName === 'BUTTON' && node.textContent === '查看官方产品更新记录');
  const click = button.click();
  cleanup();
  opened.reject(new Error('Too late'));
  await click;
  assert.equal(button.listeners.get('click').size, 0);
  assert.equal(fixture.root.children.length, 0);
  fixture.tweak.stop();
});

test('Main official notes handler ignores caller URLs and opens only the fixed product release notes URL', async () => {
  const fixture = mainFixture(() => { throw new Error('No network expected'); });
  const open = mainHandler(fixture, 'open-release-notes');
  assert.deepEqual(fixture.externalUrls, []);
  await open('https://example.invalid/attacker');
  assert.deepEqual(fixture.externalUrls, ['https://support.claude.com/en/articles/12138966-release-notes']);
  assert.deepEqual(fixture.calls, []);
  assert.deepEqual(fixture.nativeCalls, []);
  assert.deepEqual(fixture.storageReads, []);
  fixture.tweak.stop();
  assert.throws(() => open(), /stopped|停止|停用/i);
  assert.equal(fixture.externalUrls.length, 1);
});

test('Main official notes handler propagates a browser launch failure to its caller', async () => {
  const fixture = mainFixture(() => { throw new Error('No network expected'); }, new Map(), {
    openExternal: async () => { throw new Error('Browser launch failed'); },
  });
  await assert.rejects(mainHandler(fixture, 'open-release-notes')(), /Browser launch failed/);
  fixture.tweak.stop();
});
