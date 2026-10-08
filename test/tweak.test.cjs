const assert = require('node:assert/strict');
const fs = require('node:fs');
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

  async click() {
    if (this.disabled) return;
    const event = { preventDefault() {}, stopPropagation() {} };
    await Promise.all([...this.listeners.get('click') ?? []].map((handler) => handler(event)));
  }
}

function documentFixture() {
  const document = { createElement: (tag) => new Element(tag, document) };
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

function rendererFixture(invoke) {
  const document = documentFixture();
  const root = document.createElement('div');
  const registrations = [];
  let unregisterCount = 0;
  const tweak = loadTweak({ document });
  const api = {
    process: 'renderer',
    ipc: { invoke },
    settings: {
      registerPage(page) {
        registrations.push(page);
        return { unregister() { unregisterCount += 1; } };
      },
    },
  };
  tweak.start(api);
  return { tweak, root, registrations, unregisterCount: () => unregisterCount };
}

test('renderer starts without Node require and requests only the local version on render', async () => {
  const calls = [];
  const fixture = rendererFixture(async (channel) => {
    calls.push(channel);
    return '2.26454.2.0';
  });
  assert.equal(fixture.registrations.length, 1);
  assert.equal(fixture.registrations[0].id, 'main');
  assert.equal(fixture.registrations[0].title, 'Claude 更新检查');
  assert.deepEqual(calls, []);

  const cleanup = fixture.registrations[0].render(fixture.root);
  await settle();
  assert.deepEqual(calls, ['get-version']);
  assert.match(fixture.root.textContent, /2\.26454\.2\.0/);
  assert.match(fixture.root.textContent, /仅查询官方版本信息，不下载或安装更新/);
  assert.equal(find(fixture.root, (node) => node.tagName === 'BUTTON').textContent, '检查更新（不下载）');
  assert.equal(find(fixture.root, (node) => node.getAttribute('role') === 'status').getAttribute('aria-live'), 'polite');
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
  await button.click();
  assert.deepEqual(calls, ['get-version', 'check-update']);

  pending.resolve({ currentVersion: '2.26454.2.0', latestVersion: '2.30000.0', updateAvailable: true, releaseNotes: notes });
  await check;
  assert.equal(button.disabled, false);
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

function mainFixture(request, values = new Map()) {
  const calls = [];
  const storageReads = [];
  const storageWrites = [];
  const logs = [];
  const handlers = new Map();
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
    process: { arch: process.arch },
    require: (name) => name === 'electron' ? { app: { getVersion: () => '2.26454.2.0' }, net } : nodeRequire(name),
  });
  const api = {
    process: 'main',
    ipc: { handle(channel, handler) { handlers.set(channel, handler); } },
    storage: {
      get(key) { storageReads.push(key); return values.get(key); },
      set(key, value) { storageWrites.push([key, value]); values.set(key, value); },
    },
    log: { info(...args) { logs.push(args); } },
  };
  tweak.start(api);
  return { tweak, handlers, calls, storageReads, storageWrites, values, logs };
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
  await settle();
  assert.equal(fixture.calls.length, 0);
  assert.deepEqual(fixture.storageReads, []);
  assert.deepEqual(fixture.storageWrites, []);
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
  assert.equal(find(fixture.root, (node) => node.tagName === 'PRE').textContent, '官方接口未提供详细更新说明。');
  fixture.tweak.stop();
});
