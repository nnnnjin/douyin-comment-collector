'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Collector = require('../douyin-comment-collector');
const { clickProfileMessageButton, inspectMessageSurface } = require('../message-editor');
const {
  AccountProfileStore, accountIdFromUrl, detectLoggedInAccount, hasLoginSession,
  identityFromProfilePayload, identityFromRequestUrl
} = require('../account-profile-manager');
const {
  CollectorError, validateConfig, extractCommentsFromPayload, dedupeComments,
  filterCommentsByKeywords, uniqueUsers, atomicWriteJson, accountFingerprintFromCookies,
  classifyPageState, priorDelivery, ledgerKeyFor, userFingerprint
} = Collector;

const baseConfig = {
  searchKeyword: '健身',
  commentKeywords: ['想要', '怎么'],
  messageTemplate: '测试消息'
};

test('comment publication timestamps and all age filters respect boundaries', () => {
  const now = Date.parse('2026-09-29T04:00:00Z');
  assert.equal(Collector.parseCommentTime(now / 1000), new Date(now).toISOString());
  assert.equal(Collector.parseCommentTime(String(now)), new Date(now).toISOString());
  assert.equal(Collector.parseCommentTime('3分钟前', now), new Date(now - 3 * 60000).toISOString());
  assert.equal(Collector.parseCommentTime('昨天', now), new Date(now - 86400000).toISOString());
  assert.equal(Collector.parseCommentTime('验证码', now), null);
  assert.equal(Collector.parseCommentTime('2026-02-31'), null);
  assert.equal(Collector.parseCommentTime('2026-09-29'), '2026-09-28T16:00:00.000Z');
  assert.equal(Collector.normalizeComment({ text: '测试', user: { uid: 'test' }, create_time: now / 1000 }).publishedAt, new Date(now).toISOString());
  for (const days of [10, 20, 30, 365]) {
    const comments = [
      { publishedAt: new Date(now - days * 86400000).toISOString() },
      { publishedAt: new Date(now - days * 86400000 - 1).toISOString() },
      { publishedAt: null },
      { publishedAt: new Date(now + 1).toISOString() }
    ];
    assert.deepEqual(Collector.filterCommentsByTime(comments, days, now), [comments[0]]);
    assert.equal(Collector.filterCommentsByTime(comments, 0, now).length, 4);
    assert.equal(validateConfig({ ...baseConfig, commentAgeDays: days }).commentAgeDays, days);
  }
  assert.throws(() => validateConfig({ ...baseConfig, commentAgeDays: 7 }), { code: 'INVALID_CONFIG' });
});

test('ledger preserves uncertain delivery and fails closed on corrupt records', () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'collector-ledger-'));
  const collector = new Collector({ ...baseConfig, outputDir });
  const file = path.join(outputDir, 'sent-ledger.json');
  try {
    atomicWriteJson(file, [{ key: 'pending', status: 'unconfirmed' }]);
    collector.messageResults = [{ key: 'confirmed', status: 'sent' }];
    collector.saveLedger([]);
    assert.deepEqual(collector.loadLedger().map(item => item.key), ['pending', 'confirmed']);
    atomicWriteJson(file, [{ key: 'pending', status: 'sent', verificationSource: 'user_confirmed' }]);
    collector.messageResults = [];
    collector.saveLedger([]);
    assert.equal(collector.loadLedger()[0].verificationSource, 'user_confirmed');
    fs.writeFileSync(file, '{');
    assert.throws(() => collector.loadLedger(), { code: 'LEDGER_INVALID' });
  } finally { fs.rmSync(outputDir, { recursive: true }); }
});

test('validateConfig normalizes and clamps values', () => {
  const config = validateConfig({
    ...baseConfig, commentKeywords: ['想要', ' 想要 ', '怎么'],
    maxVideos: 999, pageTimeout: 1, maxMessages: -2
  });
  assert.deepEqual(config.commentKeywords, ['想要', '怎么']);
  assert.equal(config.maxVideos, 50);
  assert.equal(config.pageTimeout, 10000);
  assert.equal(config.maxMessages, 0);
  assert.deepEqual(validateConfig({ ...baseConfig, searchKeywords: ['减肥'] }).searchKeywords, ['健身', '减肥']);
  assert.equal(validateConfig(baseConfig).reviewBeforeSend, false);
});

test('validateConfig rejects incomplete runs', () => {
  assert.throws(() => validateConfig({ ...baseConfig, searchKeyword: '' }), error => {
    assert.equal(error.code, 'INVALID_CONFIG');
    return true;
  });
});

test('network payload extraction accepts nested comment lists', () => {
  const payload = { data: { comments: [
    { cid: 'c1', text: '我也想要', user: { nickname: '用户甲', sec_uid: 'sec-a' } },
    { cid: 'c2', text: '怎么报名', user: { nickname: '用户乙', sec_uid: 'sec-b' } }
  ] } };
  const comments = extractCommentsFromPayload(payload, { videoUrl: 'https://www.douyin.com/video/1', videoIndex: 1 });
  assert.equal(comments.length, 2);
  assert.equal(comments[0].source, 'network');
  assert.equal(comments[0].userLink, 'https://www.douyin.com/user/sec-a');
});

test('dedupe, keyword filter, and user dedupe are stable', () => {
  const comments = [
    { commentId: '1', userId: 'u1', username: '甲', content: '我想要', userLink: '/user/u1' },
    { commentId: '1', userId: 'u1', username: '甲', content: '我想要', userLink: '/user/u1' },
    { commentId: '2', userId: 'u1', username: '甲', content: '怎么获取', userLink: '/user/u1' },
    { commentId: '3', userId: 'u2', username: '乙', content: '路过', userLink: '/user/u2' }
  ];
  const deduped = dedupeComments(comments);
  assert.equal(deduped.length, 3);
  const matched = filterCommentsByKeywords(deduped, ['想要', '怎么']);
  assert.equal(matched.length, 2);
  assert.equal(uniqueUsers(matched).length, 1);
});

test('atomicWriteJson never leaves a temporary result', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-collector-test-'));
  const file = path.join(directory, 'result.json');
  try {
    atomicWriteJson(file, { ok: true });
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { ok: true });
    assert.deepEqual(fs.readdirSync(directory), ['result.json']);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('stop aborts an in-flight wait immediately', async () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-collector-abort-'));
  const collector = new Collector({ ...baseConfig, outputDir });
  const startedAt = Date.now();
  const waiting = collector.sleep(10000);
  collector.stop();
  await assert.rejects(waiting, error => {
    assert.ok(error instanceof CollectorError);
    assert.equal(error.code, 'ABORTED');
    return true;
  });
  assert.ok(Date.now() - startedAt < 1000);
  fs.rmSync(outputDir, { recursive: true, force: true });
});

test('operation timeout exposes a stable error code', async () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-collector-timeout-'));
  const collector = new Collector({ ...baseConfig, outputDir });
  try {
    await assert.rejects(
      collector.withTimeout(new Promise(() => {}), 10, 'TEST_TIMEOUT', '测试超时'),
      error => error.code === 'TEST_TIMEOUT' && error.message === '测试超时'
    );
  } finally {
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
});

test('run stops automatic messages after consecutive failures', async () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-collector-failures-'));
  class SimulatedCollector extends Collector {
    async init() {}
    async openDouyinAndLogin() {}
    async verifyBoundAccount() {}
    async searchKeyword() {}
    async getVideoLinks() { return ['https://www.douyin.com/video/fixture']; }
    async collectCommentsFromVideo() {
      const comments = ['a', 'b', 'c'].map((id, index) => ({
        commentId: id,
        userId: `user-${id}`,
        userLink: `https://www.douyin.com/user/user-${id}`,
        username: `用户${index + 1}`,
        content: '我想要',
        source: 'fixture'
      }));
      return this.videoResult('https://www.douyin.com/video/fixture', 1, 'success', comments, Date.now());
    }
    async sendMessage(user) {
      this.sendCalls = (this.sendCalls || 0) + 1;
      return { username: user.username, userId: user.userId, userLink: user.userLink, key: this.ledgerKey(user), status: 'failed', error: '模拟失败' };
    }
    async sleep() {}
    async close() {}
  }
  try {
    const collector = new SimulatedCollector({
      ...baseConfig,
      outputDir,
      maxConsecutiveMessageFailures: 2
    });
    const summary = await collector.run();
    assert.equal(collector.sendCalls, 2);
    assert.equal(summary.status, 'completed_with_warnings');
    assert.ok(summary.warnings.some(message => message.includes('连续私信失败')));
  } finally {
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
});

test('unexpected browser disconnect is reported as failure, not user cancellation', async () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-collector-disconnect-'));
  const collector = new Collector({ ...baseConfig, outputDir });
  collector.stop('浏览器意外关闭', 'BROWSER_DISCONNECTED');
  assert.throws(() => collector.throwIfAborted(), error => {
    assert.equal(error.code, 'BROWSER_DISCONNECTED');
    return true;
  });
  fs.rmSync(outputDir, { recursive: true, force: true });
});

test('stale Chrome profile locks are cleaned while active locks are preserved', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-collector-lock-'));
  const outputDir = path.join(root, 'output');
  const profileDir = path.join(root, 'profile');
  fs.mkdirSync(profileDir);
  const collector = new Collector({ ...baseConfig, outputDir, profileDir });
  const lockPath = path.join(profileDir, 'SingletonLock');
  fs.symlinkSync('host-99999999', lockPath);
  collector.ensureProfileAvailable();
  assert.equal(fs.existsSync(lockPath), false);

  fs.symlinkSync(`host-${process.pid}`, lockPath);
  assert.throws(() => collector.ensureProfileAvailable(), error => {
    assert.equal(error.code, 'PROFILE_IN_USE');
    return true;
  });
  fs.rmSync(root, { recursive: true, force: true });
});

test('browser profiles enforce one browser to one Douyin account', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-account-profiles-'));
  try {
    const store = new AccountProfileStore(root);
    const first = store.createDraft('账号A浏览器');
    store.bind({ ...first, profileId: first.id, accountId: 'sec-a', nickname: '账号A' });
    assert.equal(store.list()[0].ready, true);

    const second = store.createDraft('账号B浏览器');
    assert.throws(
      () => store.bind({ ...second, profileId: second.id, accountId: 'sec-a', nickname: '账号A' }),
      error => error.code === 'ACCOUNT_ALREADY_BOUND'
    );
    assert.throws(
      () => store.bind({ ...first, profileId: first.id, accountId: 'sec-b', nickname: '账号B' }),
      error => error.code === 'ACCOUNT_MISMATCH'
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('login wall is not treated as a captcha, and comment text does not block a run', () => {
  assert.equal(classifyPageState({ loginText: '验证码登录\n扫码登录' }), 'login_required');
  assert.equal(classifyPageState({ loginText: '这个验证码怎么收，求推荐' }), 'ready');
  assert.equal(classifyPageState({ dialogText: '请完成安全验证', hasCaptcha: true }), 'blocked');
});

test('result counters separate viewed, qualified, attempted, and confirmed messages', () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-collector-counters-'));
  try {
    const collector = new Collector({ ...baseConfig, outputDir });
    collector.scanStats.scanned = 40;
    collector.scanStats.pendingScanned = 8;
    collector.collectedComments = [{ commentId: '1' }, { commentId: '2' }];
    collector.scanStats.pendingQualified = 3;
    collector.messageAttempts = 4;
    collector.messageResults = [
      { status: 'sent' },
      { status: 'unconfirmed' },
      { status: 'failed' },
      { status: 'skipped_duplicate' }
    ];
    const counters = collector.counters();
    assert.equal(counters.viewed, 48);
    assert.equal(counters.collected, 5);
    assert.equal(counters.messaged, 4);
    assert.equal(counters.sent, 1);
  } finally {
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
});

test('sent and previously unconfirmed deliveries are skipped without another confirmation', () => {
  assert.equal(priorDelivery([{ key: 'a', status: 'sent' }], 'a'), 'skip');
  assert.equal(priorDelivery([{ key: 'a', status: 'unconfirmed' }], 'a'), 'skip');
  assert.equal(priorDelivery([{ key: 'a', status: 'failed' }], 'a'), null);
});

test('sent ledger is scoped to the search keyword', () => {
  const user = { userId: 'u1', userLink: 'https://www.douyin.com/user/u1' };
  const keyA = ledgerKeyFor(user, '投流');
  const keyB = ledgerKeyFor(user, '获客');
  assert.notEqual(keyA, keyB);
  const fingerprint = userFingerprint(user);
  assert.equal(priorDelivery([{ key: keyA, status: 'sent', searchKeyword: '投流', userFingerprint: fingerprint }], keyA, {
    searchKeyword: '投流', userFingerprint: fingerprint
  }), 'skip');
  assert.equal(priorDelivery([{ key: keyA, status: 'sent', searchKeyword: '投流', userFingerprint: fingerprint }], keyB, {
    searchKeyword: '获客', userFingerprint: fingerprint
  }), null);
});

test('immediate send stops after maxMessages and skips keyword duplicates', async () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-collector-immediate-'));
  class ImmediateCollector extends Collector {
    async init() {}
    async openDouyinAndLogin() {}
    async verifyBoundAccount() {}
    async searchKeyword() {}
    async getVideoLinks() {
      return [
        { url: 'https://www.douyin.com/video/1', searchKeyword: '投流' },
        { url: 'https://www.douyin.com/video/2', searchKeyword: '投流' }
      ];
    }
    async collectCommentsFromVideo(videoUrl) {
      const users = videoUrl.endsWith('/1')
        ? ['a', 'b']
        : ['b', 'c'];
      const comments = users.map((id, index) => ({
        commentId: `${videoUrl}-${id}`,
        userId: `user-${id}`,
        userLink: `https://www.douyin.com/user/user-${id}`,
        username: `用户${id}`,
        content: '我想要',
        source: 'fixture'
      }));
      return this.videoResult(videoUrl, 1, 'success', comments, Date.now());
    }
    async sendMessage(user) {
      this.sendCalls = (this.sendCalls || 0) + 1;
      this.sentUsers = [...(this.sentUsers || []), user.userId];
      return {
        username: user.username,
        userId: user.userId,
        userLink: user.userLink,
        key: this.ledgerKey(user, user.searchKeyword),
        userFingerprint: this.userFingerprint(user),
        searchKeyword: user.searchKeyword,
        status: 'sent',
        sentAt: new Date().toISOString()
      };
    }
    async sleep() {}
    async close() {}
  }
  try {
    const collector = new ImmediateCollector({
      ...baseConfig,
      searchKeyword: '投流',
      outputDir,
      maxMessages: 2,
      delayBetweenMessages: 5000
    });
    const summary = await collector.run();
    assert.equal(collector.sendCalls, 2);
    assert.deepEqual(collector.sentUsers, ['user-a', 'user-b']);
    assert.equal(summary.status, 'completed');
    const ledger = JSON.parse(fs.readFileSync(path.join(outputDir, 'sent-ledger.json'), 'utf8'));
    assert.equal(ledger.length, 2);
    assert.ok(ledger.every(item => item.searchKeyword === '投流' && item.status === 'sent'));
  } finally {
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
});

function createSimulatedCollector(outputDir, outcomes) {
  class SimulatedCollector extends Collector {
    async init() {}
    async openDouyinAndLogin() {}
    async verifyBoundAccount() {}
    async searchKeyword() {}
    async getVideoLinks() {
      return [{ url: 'https://www.douyin.com/video/1', searchKeyword: '投流' }];
    }
    async collectCommentsFromVideo(videoUrl) {
      const comments = ['a', 'b', 'c'].map(id => ({
        commentId: `${videoUrl}-${id}`,
        userId: `user-${id}`,
        userLink: `https://www.douyin.com/user/user-${id}`,
        username: `用户${id}`,
        content: '我想要',
        source: 'fixture'
      }));
      return this.videoResult(videoUrl, 1, 'success', comments, Date.now());
    }
    async sendMessage(user) {
      this.sendCalls = (this.sendCalls || 0) + 1;
      this.sentUsers = [...(this.sentUsers || []), user.userId];
      const outcome = outcomes[user.userId] || { status: 'sent' };
      return {
        username: user.username,
        userId: user.userId,
        userLink: user.userLink,
        key: this.ledgerKey(user, user.searchKeyword),
        userFingerprint: this.userFingerprint(user),
        searchKeyword: user.searchKeyword,
        ...outcome,
        sentAt: outcome.status === 'sent' ? new Date().toISOString() : undefined
      };
    }
    async sleep() {}
    async close() {}
  }
  return new SimulatedCollector({
    ...baseConfig,
    searchKeyword: '投流',
    outputDir,
    maxMessages: 1,
    delayBetweenMessages: 5000
  });
}

test('a failed open does not consume the send quota or hide the other hits', async () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-collector-quota-'));
  try {
    const collector = createSimulatedCollector(outputDir, {
      'user-a': { status: 'failed', error: '打不开输入框', errorCode: 'MESSAGE_EDITOR_TIMEOUT' }
    });
    const summary = await collector.run();
    assert.equal(collector.sendCalls, 2);
    assert.deepEqual(collector.sentUsers, ['user-a', 'user-b']);
    assert.equal(summary.counters.matched, 3);
    assert.equal(summary.counters.collected, 3);
    assert.equal(summary.counters.messaged, 2);
    assert.equal(summary.counters.sent, 1);
    assert.equal(summary.warnings.some(message => message.includes('已停止后续发送')), false);
  } finally {
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
});

test('an unconfirmed send is recorded and the run continues until a confirmed send', async () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-collector-unconfirmed-'));
  try {
    const collector = createSimulatedCollector(outputDir, {
      'user-a': { status: 'unconfirmed', error: '未确认回执', errorCode: 'DELIVERY_UNCONFIRMED' }
    });
    const summary = await collector.run();
    assert.equal(collector.sendCalls, 2);
    assert.deepEqual(collector.sentUsers, ['user-a', 'user-b']);
    assert.equal(summary.counters.sent, 1);
    assert.equal(summary.warnings.some(message => message.includes('已停止后续发送')), false);
    const ledger = JSON.parse(fs.readFileSync(path.join(outputDir, 'sent-ledger.json'), 'utf8'));
    assert.equal(ledger.find(item => item.userId === 'user-a').status, 'unconfirmed');
    assert.equal(ledger.find(item => item.userId === 'user-b').status, 'sent');
  } finally {
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
});

function matchesSelector(element, selector) {
  return selector.split(',').some(raw => {
    const part = raw.trim();
    const attr = part.match(/^([a-zA-Z0-9-]*)\[([a-zA-Z0-9-]+)(\*?)=["']([^"']+)["']\]$/);
    if (attr) {
      const [, tag, name, star, value] = attr;
      if (tag && element.tagName.toLowerCase() !== tag.toLowerCase()) return false;
      const actual = name === 'class' ? String(element.className || '') : String(element.getAttribute?.(name) || '');
      return star ? actual.includes(value) : actual === value;
    }
    return element.tagName.toLowerCase() === part.toLowerCase();
  });
}

function mountDocument(root) {
  function query(start, selector) {
    const found = [];
    const visit = node => {
      for (const child of node.children || []) {
        if (matchesSelector(child, selector)) found.push(child);
        visit(child);
      }
    };
    visit(start);
    return found;
  }
  const wire = node => {
    for (const child of node.children || []) {
      child.parentElement = node;
      wire(child);
    }
    node.querySelectorAll = selector => query(node, selector);
  };
  wire(root);
  global.document = { querySelectorAll: selector => query(root, selector) };
  global.getComputedStyle = () => ({ display: 'block', visibility: 'visible' });
  global.location = { href: 'https://www.douyin.com/user/abc' };
}

function element(tag, props = {}, children = []) {
  return {
    tagName: tag.toUpperCase(),
    innerText: props.text || '',
    textContent: props.text || '',
    className: props.className || '',
    children,
    parentElement: null,
    attributes: props.role ? { role: props.role } : {},
    getAttribute(name) { return this.attributes[name] || ''; },
    getBoundingClientRect() {
      return { top: props.top || 0, left: props.left || 0, right: (props.left || 0) + 40, width: 40, height: 24 };
    },
    getClientRects() { return [{}]; },
    click() { this.clicked = true; }
  };
}

test('profile message button is the one beside follow, not the header inbox', () => {
  const header = element('button', { text: '私信', top: 12, left: 900 });
  const follow = element('button', { text: '关注', top: 320, left: 200 });
  const profile = element('button', { text: '私信', top: 324, left: 280 });
  mountDocument(element('div', {}, [header, element('div', {}, [follow, profile])]));
  try {
    const result = clickProfileMessageButton();
    assert.equal(result.clicked, true);
    assert.equal(profile.clicked, true);
    assert.equal(header.clicked, undefined);

    mountDocument(element('div', {}, [header, element('div', {}, [follow])]));
    assert.deepEqual(clickProfileMessageButton(), { clicked: false, reason: 'no-profile-message' });
  } finally {
    delete global.document;
    delete global.getComputedStyle;
    delete global.location;
  }
});

test('message surface separates a privacy block from the inbox list', () => {
  try {
    mountDocument(element('div', {}, [
      element('div', { role: 'dialog', text: '由于对方的隐私设置，你无法发送私信' })
    ]));
    assert.equal(inspectMessageSurface(), 'restricted');

    const list = element('div', { className: 'message-list', text: '私信 最近会话' }, [
      element('li', { text: '用户一' }),
      element('li', { text: '用户二' })
    ]);
    mountDocument(element('div', {}, [list]));
    assert.equal(inspectMessageSurface(), 'inbox');

    mountDocument(element('div', { text: '个人主页' }));
    assert.equal(inspectMessageSurface(), 'pending');
  } finally {
    delete global.document;
    delete global.getComputedStyle;
    delete global.location;
  }
});

test('logged-in account id comes from the profile URL, and an old cookie binding can be upgraded', async () => {
  let url = 'https://www.douyin.com/';
  let navigated = false;
  const page = {
    url: () => url,
    cookies: async () => [{ name: 'sessionid', value: 'secret' }],
    createCDPSession: async () => ({
      send: async () => ({ cookies: [{ name: 'sessionid', value: 'secret', domain: '.douyin.com' }] }),
      detach: async () => {}
    }),
    on() {},
    off() {},
    reload: async () => {},
    goto: async () => {
      navigated = true;
      url = 'https://www.douyin.com/user/MS4wLjABAAAA-test';
    },
    waitForFunction: async () => {},
    evaluate: async () => '小明'
  };
  assert.equal(await hasLoginSession(page), true);
  const identity = await detectLoggedInAccount(page);
  assert.equal(navigated, true);
  assert.equal(identity.accountId, 'MS4wLjABAAAA-test');
  assert.equal(identity.nickname, '小明');
  page.createCDPSession = async () => ({
    send: async () => ({ cookies: [] }),
    detach: async () => {}
  });
  assert.equal(await hasLoginSession(page), false);
  assert.equal(await detectLoggedInAccount(page), null);

  assert.deepEqual(
    identityFromProfilePayload({ user: { sec_uid: 'MS4w-self', nickname: '招生-金校长' } }),
    { accountId: 'MS4w-self', nickname: '招生-金校长' }
  );
  assert.equal(
    identityFromRequestUrl('https://www.douyin.com/aweme/v1/web/aweme/post/?sec_user_id=MS4w-query&aid=1'),
    'MS4w-query'
  );
  assert.equal(identityFromRequestUrl('https://www.douyin.com/aweme/v1/web/im/user/info/?sec_user_id=other'), '');

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-account-upgrade-'));
  try {
    const store = new AccountProfileStore(root);
    const draft = store.createDraft('账号A浏览器');
    store.bind({ ...draft, profileId: draft.id, accountId: 'cookie:old', nickname: '旧绑定' });
    assert.equal(store.list()[0].ready, false);
    const upgraded = store.bind({ ...draft, profileId: draft.id, accountId: 'sec-a', nickname: '账号A' });
    assert.equal(upgraded.accountId, 'sec-a');
    assert.equal(store.list()[0].ready, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('account identity is derived only from a concrete user URL', () => {
  assert.equal(accountIdFromUrl('https://www.douyin.com/user/sec-123?from_tab_name=main'), 'sec-123');
  assert.equal(accountIdFromUrl('https://www.douyin.com/user/self'), '');
  assert.equal(accountIdFromUrl('not-a-url'), '');
});

test('login account fingerprint is stable and never exposes the cookie value', () => {
  const cookies = [
    { name: 'sessionid', value: 'session-secret' },
    { name: 'uid_tt', value: 'account-secret' }
  ];
  const first = accountFingerprintFromCookies(cookies);
  const second = accountFingerprintFromCookies([...cookies].reverse());
  assert.equal(first, second);
  assert.match(first, /^cookie:[a-f0-9]{64}$/);
  assert.equal(first.includes('account-secret'), false);
  assert.notEqual(first, accountFingerprintFromCookies([{ name: 'uid_tt', value: 'other-account' }]));
});
