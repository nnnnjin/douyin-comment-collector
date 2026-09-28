'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Collector = require('../douyin-comment-collector');
const {
  CollectorError, validateConfig, extractCommentsFromPayload, dedupeComments,
  filterCommentsByKeywords, uniqueUsers, atomicWriteJson
} = Collector;

const baseConfig = {
  searchKeyword: '健身',
  commentKeywords: ['想要', '怎么'],
  messageTemplate: '测试消息'
};

test('validateConfig normalizes and clamps values', () => {
  const config = validateConfig({
    ...baseConfig, commentKeywords: ['想要', ' 想要 ', '怎么'],
    maxVideos: 999, pageTimeout: 1, maxMessages: -2
  });
  assert.deepEqual(config.commentKeywords, ['想要', '怎么']);
  assert.equal(config.maxVideos, 50);
  assert.equal(config.pageTimeout, 10000);
  assert.equal(config.maxMessages, 0);
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
