// Copyright (c) 2026 wu. All rights reserved.
// Commercial use requires prior written permission from the copyright holder.
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PHASES = Object.freeze({
  STARTUP: 'startup', LOGIN: 'login', SEARCH: 'search', DISCOVERY: 'discovery',
  COLLECT: 'collect', FILTER: 'filter', REVIEW: 'review', MESSAGE: 'message', SAVE: 'save', COMPLETE: 'complete'
});
const VIDEO_STATUSES = new Set(['success', 'no_comments', 'selector_failed', 'login_required', 'blocked', 'timeout', 'aborted']);
const DEFAULT_CONFIG = Object.freeze({
  searchKeyword: '', commentKeywords: [], messageTemplate: '', maxVideos: 10,
  maxCommentsPerVideo: 50, delayBetweenMessages: 10000, pageTimeout: 30000,
  emptyScrollLimit: 3, maxConsecutiveMessageFailures: 3, maxMessages: 0,
  expectedAccountId: '', accountNickname: '', profileId: '', profileLabel: '',
  headless: false, outputDir: path.join(__dirname, 'output'), profileDir: path.join(__dirname, 'browser-data')
});

class CollectorError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'CollectorError';
    this.code = code;
    this.details = details;
  }
}

function clampInteger(value, fallback, min, max) {
  const number = Number.parseInt(value, 10);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function normalizeKeywords(values) {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.map(value => String(value).trim()).filter(Boolean))];
}

function validateConfig(input = {}) {
  const commentAgeDays = Number(input.commentAgeDays ?? 0);
  if (![0, 10, 20, 30, 365].includes(commentAgeDays)) throw new CollectorError('INVALID_CONFIG', '评论时间范围无效');
  const searchKeywords = normalizeKeywords(input.searchKeywords);
  const searchKeyword = String(input.searchKeyword || '').trim();
  if (searchKeyword && !searchKeywords.includes(searchKeyword)) searchKeywords.unshift(searchKeyword);
  const messageTemplate = String(input.messageTemplate || '').trim();
  const commentKeywords = normalizeKeywords(input.commentKeywords);
  if (searchKeywords.length === 0) throw new CollectorError('INVALID_CONFIG', '请输入搜索关键词');
  if (commentKeywords.length === 0) throw new CollectorError('INVALID_CONFIG', '请至少添加一个评论筛选关键词');
  if (!messageTemplate) throw new CollectorError('INVALID_CONFIG', '请输入私信内容');
  return {
    ...DEFAULT_CONFIG, searchKeyword: searchKeywords[0], searchKeywords, commentKeywords, messageTemplate, commentAgeDays,
    reviewBeforeSend: Boolean(input.reviewBeforeSend),
    maxVideos: clampInteger(input.maxVideos, DEFAULT_CONFIG.maxVideos, 1, 50),
    maxCommentsPerVideo: clampInteger(input.maxCommentsPerVideo, DEFAULT_CONFIG.maxCommentsPerVideo, 1, 200),
    delayBetweenMessages: clampInteger(input.delayBetweenMessages, DEFAULT_CONFIG.delayBetweenMessages, 5000, 120000),
    pageTimeout: clampInteger(input.pageTimeout, DEFAULT_CONFIG.pageTimeout, 10000, 90000),
    emptyScrollLimit: clampInteger(input.emptyScrollLimit, DEFAULT_CONFIG.emptyScrollLimit, 1, 10),
    maxConsecutiveMessageFailures: clampInteger(input.maxConsecutiveMessageFailures, DEFAULT_CONFIG.maxConsecutiveMessageFailures, 1, 10),
    maxMessages: clampInteger(input.maxMessages, DEFAULT_CONFIG.maxMessages, 0, 500),
    headless: Boolean(input.headless),
    expectedAccountId: String(input.expectedAccountId || '').trim(),
    accountNickname: String(input.accountNickname || '').trim(),
    profileId: String(input.profileId || '').trim(),
    profileLabel: String(input.profileLabel || '').trim(),
    outputDir: path.resolve(input.outputDir || DEFAULT_CONFIG.outputDir),
    profileDir: path.resolve(input.profileDir || DEFAULT_CONFIG.profileDir)
  };
}

function normalizeLink(link = '') {
  try {
    const url = new URL(link, 'https://www.douyin.com');
    url.search = '';
    url.hash = '';
    return url.href.replace(/\/$/, '');
  } catch {
    return String(link || '').trim();
  }
}

function parseRelativeCommentTime(text, now) {
  if (text === '刚刚') return new Date(now).toISOString();
  const matched = text.match(/^(\d+)\s*(秒|分钟|小时|天|周)前$/);
  const unitMs = { '秒': 1000, '分钟': 60000, '小时': 3600000, '天': 86400000, '周': 7 * 86400000 };
  if (matched) {
    const amount = Number(matched[1]);
    if (!Number.isFinite(amount) || amount < 0) return null;
    return new Date(now - amount * unitMs[matched[2]]).toISOString();
  }
  if (text === '昨天') return new Date(now - 86400000).toISOString();
  if (text === '前天') return new Date(now - 2 * 86400000).toISOString();
  const monthDay = text.match(/^(\d{1,2})[-/](\d{1,2})$/) || text.match(/^(\d{1,2})月(\d{1,2})日$/);
  if (!monthDay) return null;
  const month = String(Number(monthDay[1])).padStart(2, '0');
  const day = String(Number(monthDay[2])).padStart(2, '0');
  const build = year => {
    const iso = `${year}-${month}-${day}`;
    const timestamp = Date.parse(`${iso}T00:00:00+08:00`);
    if (!Number.isFinite(timestamp) || new Date(timestamp + 8 * 3600000).toISOString().slice(0, 10) !== iso) return null;
    return timestamp;
  };
  const year = new Date(now).getFullYear();
  let timestamp = build(year);
  if (timestamp == null) return null;
  if (timestamp > now) timestamp = build(year - 1);
  return timestamp == null ? null : new Date(timestamp).toISOString();
}

function parseCommentTime(value, now = Date.now()) {
  if (value == null || value === '') return null;
  const text = String(value).trim();
  let timestamp;
  if (/^\d+(\.\d+)?$/.test(text)) {
    const number = Number(text);
    timestamp = number < 1e12 ? number * 1000 : number;
  } else if (/^\d{4}-\d{2}-\d{2}T/.test(text)) timestamp = Date.parse(text);
  else if (/^\d{4}[-/]\d{1,2}[-/]\d{1,2}$/.test(text)) {
    const [year, month, day] = text.split(/[-/]/).map(Number);
    const iso = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    timestamp = Date.parse(`${iso}T00:00:00+08:00`);
    if (!Number.isFinite(timestamp) || new Date(timestamp + 8 * 3600000).toISOString().slice(0, 10) !== iso) return null;
  }
  if (Number.isFinite(timestamp) && timestamp > 0 && timestamp <= 8640000000000000) return new Date(timestamp).toISOString();
  return parseRelativeCommentTime(text, now);
}

function filterCommentsByTime(comments, days, referenceTime = Date.now()) {
  if (!days) return comments;
  const cutoff = referenceTime - days * 86400000;
  return comments.filter(comment => {
    const time = Date.parse(comment.publishedAt);
    return Number.isFinite(time) && time >= cutoff && time <= referenceTime;
  });
}

function normalizeComment(raw, context = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const user = raw.user || raw.author || raw.user_info || raw.userInfo || {};
  const content = String(raw.text || raw.content || raw.comment_text || raw.desc || '').trim();
  const username = String(user.nickname || user.name || raw.username || raw.user_name || '').trim();
  const userId = String(user.sec_uid || user.secUid || user.uid || user.unique_id || raw.user_id || '').trim();
  const explicitLink = raw.userLink || raw.user_link || user.url || '';
  const userLink = normalizeLink(explicitLink || (userId ? `https://www.douyin.com/user/${encodeURIComponent(userId)}` : ''));
  const commentId = String(raw.cid || raw.comment_id || raw.id || '').trim();
  if (!content || (!username && !userId && !userLink)) return null;
  return {
    commentId, username: username || userId || '未知用户', content, userId, userLink,
    publishedAt: parseCommentTime(raw.create_time ?? raw.createTime ?? raw.publish_time ?? raw.publishedAt ?? raw.timeText),
    timeText: String(raw.timeText || ''),
    videoUrl: context.videoUrl || '', videoIndex: context.videoIndex || 0, source: context.source || 'unknown'
  };
}

function findCommentArrays(value, depth = 0, seen = new Set()) {
  if (!value || typeof value !== 'object' || depth > 6 || seen.has(value)) return [];
  seen.add(value);
  const arrays = [];
  for (const [key, child] of Object.entries(value)) {
    if (Array.isArray(child)) {
      if (/comments?|comment_list/i.test(key) || child.some(item => item && typeof item === 'object' && ('text' in item || 'comment_text' in item))) arrays.push(child);
      for (const item of child.slice(0, 10)) arrays.push(...findCommentArrays(item, depth + 1, seen));
    } else if (child && typeof child === 'object') arrays.push(...findCommentArrays(child, depth + 1, seen));
  }
  return arrays;
}

function extractCommentsFromPayload(payload, context = {}) {
  const comments = [];
  const keys = new Set();
  for (const array of findCommentArrays(payload)) {
    for (const raw of array) {
      const comment = normalizeComment(raw, { ...context, source: 'network' });
      if (!comment) continue;
      const key = comment.commentId || `${comment.userId || comment.userLink || comment.username}\u0000${comment.content}`;
      if (!keys.has(key)) {
        keys.add(key);
        comments.push(comment);
      }
    }
  }
  return comments;
}

function dedupeComments(comments) {
  const seen = new Set();
  return comments.filter(comment => {
    const key = comment.commentId || `${comment.userId || comment.userLink || comment.username}\u0000${comment.content}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function filterCommentsByKeywords(comments, keywords) {
  const normalized = keywords.map(keyword => keyword.toLocaleLowerCase());
  return comments.filter(comment => {
    const content = String(comment.content || '').toLocaleLowerCase();
    return normalized.some(keyword => content.includes(keyword));
  });
}

function annotateMatches(comments, keywords) {
  const normalized = keywords.map(keyword => ({ raw: keyword, lower: keyword.toLocaleLowerCase() }));
  const matched = [];
  for (const comment of comments) {
    const content = String(comment.content || '').toLocaleLowerCase();
    const hit = normalized.find(keyword => content.includes(keyword.lower));
    if (hit) matched.push({ ...comment, matchedKeyword: hit.raw });
  }
  return matched;
}

function classifyPageState({ dialogText = '', loginText = '', hasCaptcha = false } = {}) {
  const dialog = String(dialogText);
  const login = String(loginText);
  if (hasCaptcha || /访问频繁|操作频繁|滑块验证|账号存在风险|请完成验证|安全验证/.test(dialog)) return 'blocked';
  if (/扫码登录|密码登录|验证码登录/.test(`${login}\n${dialog}`)) return 'login_required';
  return 'ready';
}

function userFingerprint(user = {}) {
  return crypto.createHash('sha256').update(String(user.userId || normalizeLink(user.userLink) || '')).digest('hex');
}

function ledgerKeyFor(user = {}, searchKeyword = '') {
  return crypto.createHash('sha256')
    .update(`${String(searchKeyword || '').trim()}\u0000${String(user.userId || normalizeLink(user.userLink) || '')}`)
    .digest('hex');
}

function priorDelivery(ledger, key, options = {}) {
  const items = Array.isArray(ledger) ? ledger : [];
  const searchKeyword = String(options.searchKeyword || '').trim();
  const fingerprint = String(options.userFingerprint || '');
  const item = items.find(entry => {
    if (!entry) return false;
    if (entry.key === key) return true;
    if (!fingerprint) return false;
    // Legacy records used only the user hash and apply to every keyword.
    if (entry.key === fingerprint) return true;
    if (entry.userFingerprint === fingerprint) {
      if (!entry.searchKeyword) return true;
      return entry.searchKeyword === searchKeyword;
    }
    return false;
  });
  if (!item) return null;
  if (item.status === 'sent' || item.status === 'unconfirmed') return 'skip';
  return null;
}

function reachedOlderComments(comments, days, now) {
  if (!days || !comments.length) return false;
  const time = Date.parse(comments[comments.length - 1]?.publishedAt || '');
  return Number.isFinite(time) && time < now - days * 86400000;
}

function uniqueUsers(comments) {
  const seen = new Set();
  const users = [];
  for (const comment of comments) {
    const key = comment.userId || normalizeLink(comment.userLink);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    users.push(comment);
  }
  return users;
}

function atomicWriteJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(temporaryPath, filePath);
}

function safeUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    url.search = '';
    url.hash = '';
    return url.href;
  } catch {
    return '';
  }
}

function accountFingerprintFromCookies(cookies = []) {
  const preferredNames = ['uid_tt', 'uid_tt_ss', 'passport_assist_user', 'sessionid', 'sessionid_ss'];
  for (const name of preferredNames) {
    const cookie = cookies.find(item => item.name === name && item.value);
    if (cookie) {
      return `cookie:${crypto.createHash('sha256').update(`${name}:${cookie.value}`).digest('hex')}`;
    }
  }
  return '';
}

function ensureProfileAvailable(profileDir) {
  fs.mkdirSync(profileDir, { recursive: true });
  const lockPath = path.join(profileDir, 'SingletonLock');
  try { fs.lstatSync(lockPath); }
  catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  let active = false;
  try {
    const match = fs.readlinkSync(lockPath).match(/-(\d+)$/);
    if (match) {
      try { process.kill(Number(match[1]), 0); active = true; }
      catch (error) { active = error.code === 'EPERM'; }
    }
  } catch { active = false; }
  if (active) throw new CollectorError('PROFILE_IN_USE', '浏览器资料目录正在被另一个采集任务使用，请先关闭旧窗口');
  for (const name of ['SingletonLock', 'SingletonCookie', 'SingletonSocket', 'DevToolsActivePort']) {
    try { fs.unlinkSync(path.join(profileDir, name)); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

class DouyinCommentCollector {
  constructor(config = {}, options = {}) {
    this.config = validateConfig(config);
    this.runId = options.runId || crypto.randomUUID();
    this.onProgress = typeof options.onProgress === 'function' ? options.onProgress : () => {};
    this.browser = null;
    this.page = null;
    this.abortController = new AbortController();
    this.abortCode = 'ABORTED';
    this.abortMessage = '任务已停止';
    this.isRunning = false;
    this.closePromise = null;
    this.heartbeatTimer = null;
    this.lastActivityAt = new Date().toISOString();
    this.lastMessage = '任务运行中';
    this.lastProgress = null;
    this.scanStats = { scanned: 0, pendingScanned: 0, pendingQualified: 0, unknownTime: 0 };
    this.messageAttempts = 0;
    this.retainBrowserOnExit = false;
    this.phase = PHASES.STARTUP;
    this.collectedComments = [];
    this.matchedUsers = [];
    this.messageResults = [];
    this.videoResults = [];
    this.warnings = [];
    this.startedAt = new Date().toISOString();
    fs.mkdirSync(this.config.outputDir, { recursive: true });
  }

  get signal() { return this.abortController.signal; }

  counters() {
    const sent = this.messageResults.filter(result => result.status === 'sent').length;
    return {
      videos: this.videoResults.length,
      viewed: this.scanStats.scanned + (this.scanStats.pendingScanned || 0),
      collected: this.collectedComments.length + (this.scanStats.pendingQualified || 0),
      messaged: this.messageAttempts || 0,
      sent,
      comments: this.collectedComments.length,
      matched: this.matchedUsers.length,
      failed: this.videoResults.filter(result => result.status !== 'success').length +
        this.messageResults.filter(result => !['sent', 'skipped_duplicate'].includes(result.status)).length
    };
  }

  emit(status, message, extra = {}) {
    this.lastActivityAt = new Date().toISOString();
    this.lastMessage = message;
    if (extra.progress) this.lastProgress = extra.progress;
    this.onProgress({
      runId: this.runId, phase: this.phase, status, progress: extra.progress || this.lastProgress,
      counters: this.counters(), message, errorCode: extra.errorCode || null,
      lastActivityAt: this.lastActivityAt, ...extra
    });
  }

  setPhase(phase, message) { this.phase = phase; this.emit('running', message); }
  abortError() { return new CollectorError(this.abortCode, this.abortMessage); }
  throwIfAborted() { if (this.signal.aborted) throw this.abortError(); }

  sleep(ms) {
    this.throwIfAborted();
    return new Promise((resolve, reject) => {
      const onAbort = () => { clearTimeout(timer); reject(this.abortError()); };
      const timer = setTimeout(() => { this.signal.removeEventListener('abort', onAbort); resolve(); }, ms);
      this.signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  async withTimeout(promise, timeoutMs, code, message) {
    let timer;
    let onAbort;
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new CollectorError(code, message)), timeoutMs); });
    const aborted = new Promise((_, reject) => {
      onAbort = () => reject(this.abortError());
      this.signal.addEventListener('abort', onAbort, { once: true });
    });
    try { return await Promise.race([promise, timeout, aborted]); }
    finally {
      clearTimeout(timer);
      this.signal.removeEventListener('abort', onAbort);
    }
  }

  async retry(label, action, attempts = 2) {
    let lastError;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      this.throwIfAborted();
      try { return await action(attempt); }
      catch (error) {
        lastError = error;
        if (['ABORTED', 'BROWSER_DISCONNECTED', 'BLOCKED', 'LOGIN_REQUIRED'].includes(error.code) || attempt === attempts) throw error;
        this.emit('retrying', `${label}失败，正在重试 (${attempt}/${attempts})`, { errorCode: error.code || 'RETRY' });
        await this.sleep(1000);
      }
    }
    throw lastError;
  }

  ensureProfileAvailable() {
    ensureProfileAvailable(this.config.profileDir);
  }

  async init() {
    this.setPhase(PHASES.STARTUP, '正在检查浏览器环境');
    this.ensureProfileAvailable();
    let puppeteer;
    try { puppeteer = require('puppeteer'); }
    catch (error) { throw new CollectorError('DEPENDENCY_ERROR', `Puppeteer 加载失败：${error.message}`); }
    let executablePath;
    try {
      executablePath = await puppeteer.executablePath();
      if (!executablePath || !fs.existsSync(executablePath)) throw new Error('浏览器文件不存在');
    } catch { throw new CollectorError('BROWSER_MISSING', '缺少与 Puppeteer 配套的 Chrome，请运行 npm run browser:install'); }
    this.emit('running', '正在启动配套浏览器');
    this.browser = await puppeteer.launch({
      headless: this.config.headless, executablePath, userDataDir: this.config.profileDir,
      args: ['--disable-blink-features=AutomationControlled', '--window-size=1400,900']
    });
    this.page = await this.browser.newPage();
    await this.page.setViewport({ width: 1400, height: 900 });
    this.page.setDefaultNavigationTimeout(this.config.pageTimeout);
    this.page.setDefaultTimeout(Math.min(10000, this.config.pageTimeout));
    this.page.on('dialog', async dialog => { this.warnings.push(`页面弹窗：${dialog.type()}`); await dialog.dismiss().catch(() => {}); });
    this.browser.on('disconnected', () => {
      if (this.isRunning && !this.signal.aborted) this.stop('浏览器意外关闭', 'BROWSER_DISCONNECTED');
    });
    this.startHeartbeat();
    this.emit('running', '浏览器启动成功');
  }

  startHeartbeat() {
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => {
      if (this.isRunning) this.onProgress({
        runId: this.runId, phase: this.phase, status: 'heartbeat', progress: this.lastProgress,
        counters: this.counters(), message: this.lastMessage, errorCode: null, lastActivityAt: this.lastActivityAt
      });
    }, 2000);
  }

  async navigate(url, label) {
    return this.retry(label, async () => {
      this.throwIfAborted();
      await this.withTimeout(
        this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: this.config.pageTimeout }),
        this.config.pageTimeout + 1000, 'NAVIGATION_TIMEOUT', `${label}超时`
      );
      await this.sleep(800);
      const state = await this.detectPageState();
      if (state === 'blocked') throw new CollectorError('BLOCKED', '页面出现验证码或访问限制，需要人工处理');
      return state;
    });
  }

  async detectPageState() {
    if (!this.page || this.page.isClosed()) return 'closed';
    const snapshot = await this.page.evaluate(() => {
      const visible = element => {
        if (!element) return false;
        const style = getComputedStyle(element);
        const rects = element.getClientRects();
        return style.display !== 'none' && style.visibility !== 'hidden' && rects.length > 0 && rects[0].width > 20 && rects[0].height > 20;
      };
      const dialogs = Array.from(document.querySelectorAll('[role="dialog"], [role="alertdialog"]')).filter(visible);
      const captchaNodes = Array.from(document.querySelectorAll(
        '[class*="captcha"], [id*="captcha"], [class*="Captcha"], [id*="Captcha"], iframe[src*="captcha"], iframe[src*="slide"], iframe[src*="verifycenter"]'
      )).filter(visible);
      return {
        dialogText: dialogs.map(element => element.innerText || '').join('\n').slice(0, 5000),
        hasCaptcha: captchaNodes.length > 0,
        loginText: `${document.title || ''}\n${(document.body?.innerText || '').slice(0, 3000)}`
      };
    }).catch(() => null);
    if (!snapshot) return 'closed';
    return classifyPageState(snapshot);
  }

  async checkLoginStatus() {
    if (!this.page || this.page.isClosed()) return false;
    return require('./account-profile-manager').hasLoginSession(this.page);
  }

  async openDouyinAndLogin() {
    this.setPhase(PHASES.LOGIN, '正在打开抖音并确认登录状态');
    await this.navigate('https://www.douyin.com/', '打开抖音');
    const deadline = Date.now() + 180000;
    while (Date.now() < deadline) {
      this.throwIfAborted();
      const state = await this.detectPageState();
      if (state === 'blocked') throw new CollectorError('BLOCKED', '登录页面出现验证码或访问限制，请在浏览器中处理后重试');
      if (await this.checkLoginStatus()) { this.emit('running', '登录状态确认成功'); return; }
      this.emit('waiting', '请在浏览器中完成登录', { progress: { current: Math.floor((180000 - (deadline - Date.now())) / 1000), total: 180 } });
      await this.sleep(2000);
    }
    throw new CollectorError('LOGIN_TIMEOUT', '等待登录超时，请重新启动任务');
  }

  async verifyBoundAccount() {
    if (!this.config.expectedAccountId) {
      throw new CollectorError('PROFILE_NOT_BOUND', '当前浏览器尚未绑定抖音账号，请先在主界面准备浏览器');
    }
    this.emit('running', `正在核对浏览器账号：${this.config.profileLabel || '已选浏览器'}`);
    if (this.config.expectedAccountId.startsWith('cookie:')) {
      throw new CollectorError('PROFILE_NOT_BOUND', '这个浏览器还是旧的 Cookie 绑定，请在主界面点击“检查所选”重新绑定账号');
    }
    const { detectLoggedInAccount, hasLoginSession } = require('./account-profile-manager');
    if (!(await hasLoginSession(this.page))) {
      throw new CollectorError('LOGIN_REQUIRED', '当前浏览器没有有效登录态，请重新准备该浏览器');
    }
    const identity = await detectLoggedInAccount(this.page);
    if (!identity?.accountId) {
      throw new CollectorError('ACCOUNT_ID_MISSING', '无法识别当前登录账号，请重新准备该浏览器');
    }
    if (identity.accountId !== this.config.expectedAccountId) {
      throw new CollectorError(
        'ACCOUNT_MISMATCH',
        `浏览器账号不匹配：请选择或登录已绑定的“${this.config.accountNickname || this.config.profileLabel || '原账号'}”`
      );
    }
    this.emit('running', `账号核对通过：${identity.nickname || this.config.accountNickname || this.config.profileLabel}`);
  }

  async openSearch(keyword) {
    const url = `https://www.douyin.com/search/${encodeURIComponent(keyword)}?type=video`;
    const state = await this.navigate(url, `搜索“${keyword}”`);
    if (state === 'login_required') throw new CollectorError('LOGIN_REQUIRED', '登录状态已失效');
    await this.page.waitForFunction(() => document.querySelectorAll('a[href*="/video/"]').length > 0 || /未找到|暂无相关/.test(document.body?.innerText || ''),
      { timeout: Math.min(15000, this.config.pageTimeout) }).catch(() => {});
  }

  async searchKeyword() {
    this.setPhase(PHASES.SEARCH, `正在搜索“${this.config.searchKeywords[0]}”`);
    await this.openSearch(this.config.searchKeywords[0]);
  }

  async collectVisibleVideoLinks(videos, searchKeyword) {
    let stagnant = 0;
    while (videos.size < this.config.maxVideos && stagnant < 3) {
      this.throwIfAborted();
      const before = videos.size;
      const links = await this.page.evaluate(() => Array.from(document.querySelectorAll('a[href*="/video/"]'))
        .filter(element => {
          const style = getComputedStyle(element);
          return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0;
        }).map(element => element.href));
      for (const link of links) {
        if (videos.size >= this.config.maxVideos) break;
        const url = normalizeLink(link);
        if (!videos.has(url)) videos.set(url, searchKeyword);
      }
      stagnant = videos.size === before ? stagnant + 1 : 0;
      this.emit('running', `已发现 ${videos.size} 个视频`, { progress: { current: videos.size, total: this.config.maxVideos } });
      if (videos.size >= this.config.maxVideos) break;
      await this.page.evaluate(() => window.scrollBy(0, Math.max(window.innerHeight, 700)));
      await this.sleep(1200);
    }
  }

  async getVideoLinks() {
    this.setPhase(PHASES.DISCOVERY, '正在获取视频列表');
    const videos = new Map();
    const keywords = this.config.searchKeywords;
    for (let index = 0; index < keywords.length && videos.size < this.config.maxVideos; index += 1) {
      if (index > 0) {
        this.setPhase(PHASES.SEARCH, `正在搜索“${keywords[index]}”`);
        await this.openSearch(keywords[index]);
      }
      await this.collectVisibleVideoLinks(videos, keywords[index]);
    }
    if (videos.size === 0) throw new CollectorError('NO_VIDEOS', '没有找到视频；可能是页面结构变化、搜索无结果或登录失效');
    return [...videos.entries()].slice(0, this.config.maxVideos).map(([url, searchKeyword]) => ({ url, searchKeyword }));
  }

  async openCommentPanel() {
    const clicked = await this.page.evaluate(() => {
      const visible = element => {
        const style = getComputedStyle(element);
        return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0;
      };
      const candidates = Array.from(document.querySelectorAll('[data-e2e="comment-icon"], [aria-label*="评论"], button, [role="button"]'));
      const target = candidates.find(element => {
        if (!visible(element)) return false;
        const text = `${element.getAttribute('aria-label') || ''} ${element.textContent || ''}`.trim();
        return /评论/.test(text) && text.length < 80;
      });
      if (!target) return false;
      target.click();
      return true;
    });
    if (clicked) await this.sleep(800);
    return clicked;
  }

  async extractDomComments(videoUrl, videoIndex) {
    const rawComments = await this.page.evaluate(() => {
      const selectors = ['[data-e2e="comment-item"]', '[role="listitem"]:has(a[href*="/user/"])', 'li:has(a[href*="/user/"])'];
      let elements = [];
      for (const selector of selectors) {
        try {
          elements = Array.from(document.querySelectorAll(selector)).filter(element => {
            const style = getComputedStyle(element);
            return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0;
          });
        }
        catch { elements = []; }
        if (elements.length > 0) break;
      }
      return elements.map(element => {
        const link = element.querySelector('a[href*="/user/"]');
        const nameElement = element.querySelector('[data-e2e="comment-user-name"], [data-e2e="user-name"], a[href*="/user/"]');
        const textElement = element.querySelector('[data-e2e="comment-text"], [data-e2e="comment-content"], p, [dir="auto"]');
        const timeElement = element.querySelector('time, [data-e2e="comment-time"]');
        return { username: (nameElement?.textContent || '').trim(), content: (textElement?.textContent || '').trim(), userLink: link?.href || '',
          publishedAt: timeElement?.getAttribute('datetime') || null, timeText: (timeElement?.textContent || '').trim() };
      });
    });
    return rawComments.map(raw => normalizeComment(raw, { videoUrl, videoIndex, source: 'dom' })).filter(Boolean);
  }

  async scrollComments() {
    return this.page.evaluate(() => {
      const candidates = Array.from(document.querySelectorAll('[data-e2e="comment-list"], [role="list"], div'))
        .filter(element => {
          const style = getComputedStyle(element);
          return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0 && element.scrollHeight > element.clientHeight + 100;
        })
        .filter(element => element.querySelector('a[href*="/user/"]'));
      const container = candidates.sort((a, b) => b.querySelectorAll('a[href*="/user/"]').length - a.querySelectorAll('a[href*="/user/"]').length)[0];
      if (!container) return false;
      container.scrollBy(0, Math.max(container.clientHeight * 0.8, 500));
      return true;
    });
  }

  async collectCommentsFromVideo(videoUrl, videoIndex, totalVideos) {
    const started = Date.now();
    const networkComments = [];
    const onResponse = async response => {
      try {
        const contentType = response.headers()['content-type'] || '';
        if (!/comment/i.test(response.url()) || !/json/i.test(contentType)) return;
        networkComments.push(...extractCommentsFromPayload(await response.json(), { videoUrl, videoIndex }));
      } catch { /* Ignore responses that cannot be consumed. */ }
    };
    this.page.on('response', onResponse);
    let scanned = [];
    try {
      this.emit('running', `正在打开视频 ${videoIndex}/${totalVideos}`, { progress: { current: videoIndex, total: totalVideos } });
      const state = await this.navigate(videoUrl, `打开视频 ${videoIndex}`);
      if (state === 'login_required') return this.videoResult(videoUrl, videoIndex, 'login_required', [], started, '登录状态已失效');
      await this.openCommentPanel();
      let emptyRounds = 0;
      let previousCount = 0;
      const scanCap = Math.min(500, Math.max(this.config.maxCommentsPerVideo * 8, this.config.maxCommentsPerVideo));
      const referenceTime = Date.parse(this.startedAt);
      while (emptyRounds < this.config.emptyScrollLimit && scanned.length < scanCap) {
        this.throwIfAborted();
        if (await this.detectPageState() === 'blocked') {
          const blockedLeads = this.selectLeads(scanned).slice(0, this.config.maxCommentsPerVideo);
          return this.videoResult(videoUrl, videoIndex, 'blocked', blockedLeads, started, '出现验证码或访问限制');
        }
        scanned = dedupeComments([...scanned, ...networkComments, ...await this.extractDomComments(videoUrl, videoIndex)]);
        const matched = this.selectLeads(scanned);
        emptyRounds = scanned.length === previousCount ? emptyRounds + 1 : 0;
        previousCount = scanned.length;
        this.scanStats.pendingScanned = scanned.length;
        this.scanStats.pendingQualified = Math.min(matched.length, this.config.maxCommentsPerVideo);
        this.emit('running', `视频 ${videoIndex}/${totalVideos}：已查看 ${scanned.length} 条，符合条件 ${this.scanStats.pendingQualified} 条`, {
          progress: { current: videoIndex, total: totalVideos, comments: this.scanStats.pendingQualified, emptyRounds }
        });
        if (matched.length >= this.config.maxCommentsPerVideo) break;
        if (reachedOlderComments(scanned, this.config.commentAgeDays, referenceTime)) break;
        const scrolled = await this.scrollComments();
        if (!scrolled && scanned.length === 0) emptyRounds = this.config.emptyScrollLimit;
        await this.sleep(1000);
      }
      const comments = this.selectLeads(scanned).slice(0, this.config.maxCommentsPerVideo);
      if (comments.length > 0) return this.videoResult(videoUrl, videoIndex, 'success', comments, started);
      const hasCommentSurface = await this.page.evaluate(() => Boolean(document.querySelector(
        '[data-e2e="comment-list"], [data-e2e="comment-item"], [aria-label*="评论"]'))).catch(() => false);
      return this.videoResult(videoUrl, videoIndex, hasCommentSurface ? 'no_comments' : 'selector_failed', [], started,
        hasCommentSurface ? '评论区没有符合条件的评论' : '未识别到评论区结构');
    } catch (error) {
      const status = this.signal.aborted || error.code === 'ABORTED'
        ? 'aborted'
        : error.code === 'BLOCKED' ? 'blocked'
          : error.code === 'LOGIN_REQUIRED' ? 'login_required' : 'timeout';
      return this.videoResult(videoUrl, videoIndex, status, [], started, error.message);
    } finally {
      this.scanStats.scanned += scanned.length;
      this.scanStats.unknownTime += scanned.filter(comment => !comment.publishedAt).length;
      this.scanStats.pendingScanned = 0;
      this.scanStats.pendingQualified = 0;
      if (this.page && !this.page.isClosed()) this.page.off('response', onResponse);
    }
  }

  videoResult(videoUrl, videoIndex, status, comments, started, error = '') {
    if (!VIDEO_STATUSES.has(status)) status = 'selector_failed';
    return { videoUrl: safeUrl(videoUrl), videoIndex, status, commentCount: comments.length, comments, durationMs: Date.now() - started, error };
  }

  loadLedger() {
    try {
      const ledger = JSON.parse(fs.readFileSync(path.join(this.config.outputDir, 'sent-ledger.json'), 'utf8'));
      return Array.isArray(ledger) ? ledger : [];
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw new CollectorError('LEDGER_INVALID', '发送记录无法读取，已停止，避免重复发送');
    }
  }

  userFingerprint(user) {
    return userFingerprint(user);
  }

  ledgerKey(user, searchKeyword = user.searchKeyword || this.config.searchKeyword) {
    return ledgerKeyFor(user, searchKeyword);
  }

  async clickByText(pattern) {
    return this.page.evaluate(source => {
      const regex = new RegExp(source);
      const target = Array.from(document.querySelectorAll('button, [role="button"], a'))
        .find(element => {
          const style = getComputedStyle(element);
          const visible = style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0;
          return visible && regex.test((element.textContent || '').replace(/\s+/g, ''));
        });
      if (!target) return false;
      target.click();
      return true;
    }, pattern.source);
  }

  rememberLead(user, patch = {}) {
    const view = this.leadView({ ...user, ...patch }, patch.searchKeyword || user.searchKeyword);
    const index = this.matchedUsers.findIndex(item => item.key === view.key);
    if (index >= 0) {
      this.matchedUsers[index] = {
        ...this.matchedUsers[index],
        ...view,
        content: view.content || this.matchedUsers[index].content
      };
      return;
    }
    this.matchedUsers.push(view);
  }

  async readMessageSurface(pages) {
    const { inspectMessageSurface } = require('./message-editor');
    for (const candidate of pages) {
      if (!candidate || candidate.isClosed?.()) continue;
      try {
        const surface = await candidate.evaluate(inspectMessageSurface);
        if (surface === 'restricted' || surface === 'inbox') return surface;
      } catch (error) {
        if (!/detached|destroyed|closed|context/i.test(error.message || '')) throw error;
      }
    }
    return 'pending';
  }

  selectLeads(comments) {
    const referenceTime = Date.parse(this.startedAt);
    const eligible = filterCommentsByTime(comments, this.config.commentAgeDays, referenceTime);
    return annotateMatches(eligible, this.config.commentKeywords);
  }

  leadView(user, searchKeyword = user.searchKeyword || this.config.searchKeyword) {
    const fingerprint = user.userFingerprint || this.userFingerprint(user);
    return {
      key: user.key || this.ledgerKey(user, searchKeyword),
      userFingerprint: fingerprint,
      searchKeyword: String(searchKeyword || ''),
      username: user.username,
      userId: user.userId || '',
      userLink: normalizeLink(user.userLink),
      content: user.content || '',
      publishedAt: user.publishedAt || null,
      timeText: user.timeText || '',
      matchedKeyword: user.matchedKeyword || '',
      videoUrl: user.videoUrl || '',
      commentId: user.commentId || '',
      status: user.status || '',
      error: user.error || ''
    };
  }

  writePendingCampaign() {
    const leads = this.matchedUsers.map(user => this.leadView(user));
    atomicWriteJson(path.join(this.config.outputDir, 'pending-send.json'), {
      runId: this.runId,
      createdAt: new Date().toISOString(),
      config: {
        searchKeyword: this.config.searchKeyword,
        searchKeywords: this.config.searchKeywords,
        commentKeywords: this.config.commentKeywords,
        messageTemplate: this.config.messageTemplate,
        commentAgeDays: this.config.commentAgeDays,
        maxVideos: this.config.maxVideos,
        maxCommentsPerVideo: this.config.maxCommentsPerVideo,
        delayBetweenMessages: this.config.delayBetweenMessages,
        pageTimeout: this.config.pageTimeout,
        emptyScrollLimit: this.config.emptyScrollLimit,
        maxConsecutiveMessageFailures: this.config.maxConsecutiveMessageFailures,
        maxMessages: this.config.maxMessages,
        headless: this.config.headless,
        profileId: this.config.profileId,
        profileLabel: this.config.profileLabel,
        expectedAccountId: this.config.expectedAccountId,
        accountNickname: this.config.accountNickname,
        outputDir: this.config.outputDir,
        profileDir: this.config.profileDir
      },
      leads
    });
    return leads;
  }

  updatePendingStatuses() {
    const filePath = path.join(this.config.outputDir, 'pending-send.json');
    let pending;
    try { pending = JSON.parse(fs.readFileSync(filePath, 'utf8')); }
    catch { return; }
    if (!pending || !Array.isArray(pending.leads) || this.messageResults.length === 0) return;
    const results = new Map(this.messageResults.map(result => [result.key, result]));
    pending.leads = pending.leads.map(lead => {
      const result = results.get(lead.key);
      return result ? { ...lead, status: result.status, error: result.error || '' } : lead;
    });
    pending.updatedAt = new Date().toISOString();
    atomicWriteJson(filePath, pending);
  }

  releaseUnconfirmed(keys) {
    const drop = new Set((keys || []).map(String).filter(Boolean));
    if (drop.size === 0) return;
    const next = this.loadLedger().filter(item => !(drop.has(item.key) && item.status === 'unconfirmed'));
    atomicWriteJson(path.join(this.config.outputDir, 'sent-ledger.json'), next);
  }

  async sendMessage(user, message, index, total) {
    const searchKeyword = user.searchKeyword || this.config.searchKeyword;
    const fingerprint = user.userFingerprint || this.userFingerprint(user);
    const key = user.key || this.ledgerKey(user, searchKeyword);
    const base = {
      username: user.username,
      userId: user.userId,
      userLink: normalizeLink(user.userLink),
      key,
      userFingerprint: fingerprint,
      searchKeyword: String(searchKeyword || '')
    };
    const sourcePage = this.page;
    const popups = new Set();
    const onPopup = page => popups.add(page);
    sourcePage.on('popup', onPopup);
    let input;
    let submitted = false;
    const editorApi = require('./message-editor');
    try {
      const state = await this.navigate(user.userLink, `打开用户 ${index}/${total}`);
      if (state === 'blocked') return { ...base, status: 'blocked', error: '出现验证码或访问限制' };
      if (state === 'login_required') return { ...base, status: 'failed', error: '登录状态已失效' };
      const buttonDeadline = Date.now() + 12000;
      let opened = false;
      while (!opened && Date.now() < buttonDeadline) {
        this.throwIfAborted();
        const click = await sourcePage.evaluate(editorApi.clickProfileMessageButton);
        opened = Boolean(click && click.clicked);
        if (!opened) await this.sleep(250);
      }
      if (!opened) {
        return {
          ...base,
          status: 'unavailable',
          error: '未找到主页上与关注并排的私信按钮',
          errorCode: 'MESSAGE_BUTTON_MISSING'
        };
      }
      this.emit('running', '已打开私信，正在等待聊天输入框');
      const editorDeadline = Date.now() + 8000;
      let editor = null;
      while (!editor && Date.now() < editorDeadline) {
        this.throwIfAborted();
        const surface = await this.readMessageSurface([sourcePage, ...popups]);
        if (surface === 'restricted') {
          return { ...base, status: 'unavailable', error: '对方限制私信', errorCode: 'MESSAGE_RESTRICTED' };
        }
        if (surface === 'inbox') {
          return {
            ...base,
            status: 'failed',
            error: '打开的是消息列表，没有进入该用户会话',
            errorCode: 'MESSAGE_INBOX_OPENED'
          };
        }
        try {
          editor = await editorApi.waitForMessageEditor(sourcePage, popups, { signal: this.signal, timeout: 400 });
        } catch (error) {
          if (error.code === 'ABORTED') throw error;
          if (error.code !== 'MESSAGE_EDITOR_TIMEOUT') throw error;
        }
      }
      if (!editor) {
        return {
          ...base,
          status: 'failed',
          error: '私信窗口等待后仍无可用输入框，可能未打开会话、对方限制私信或页面结构变化',
          errorCode: 'MESSAGE_EDITOR_TIMEOUT'
        };
      }
      input = editor.input;
      const frame = editor.frame;
      this.throwIfAborted();
      await input.click();
      const draft = await input.evaluate(editorApi.inspectDraft);
      if (draft.hasDraft) throw new CollectorError('EXISTING_DRAFT', `聊天输入框存在${draft.hasAttachment ? '附件或' : ''}实际内容（${draft.textLength}字），已保留并跳过`);
      await input.type(message, { delay: 35 });
      this.throwIfAborted();
      let clicked = false;
      try {
        clicked = await frame.evaluate(editorApi.clickSendButton);
        if (!clicked) await input.press('Enter');
      } catch (error) {
        if (!clicked) throw error;
      }
      submitted = true;
      const sentAt = new Date().toISOString();
      const ledger = this.loadLedger().filter(item => item.key !== key);
      ledger.push({ ...base, status: 'sent', runId: this.runId, sentAt });
      atomicWriteJson(path.join(this.config.outputDir, 'sent-ledger.json'), ledger);
      return { ...base, status: 'sent', sentAt };
    } catch (error) {
      if (this.signal.aborted) this.throwIfAborted();
      if (submitted) return { ...base, status: 'sent', sentAt: new Date().toISOString() };
      return { ...base, status: error.code === 'BLOCKED' ? 'blocked' : 'failed', error: error.message, errorCode: error.code || 'MESSAGE_FAILED' };
    } finally {
      sourcePage.off('popup', onPopup);
      if (input) await input.dispose().catch(() => {});
      for (const popup of popups) await popup.close().catch(() => {});
    }
  }

  saveResults(finalStatus = 'completed') {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const summary = {
      runId: this.runId, status: finalStatus, startedAt: this.startedAt, finishedAt: new Date().toISOString(),
      searchKeyword: this.config.searchKeyword, searchKeywords: this.config.searchKeywords, commentKeywords: this.config.commentKeywords,
      timeFilter: this.timeFilter || { days: this.config.commentAgeDays },
      counters: this.counters(), videoResults: this.videoResults.map(({ comments, ...result }) => result),
      messageResults: this.messageResults, warnings: this.warnings
    };
    atomicWriteJson(path.join(this.config.outputDir, `run_${timestamp}.json`), summary);
    atomicWriteJson(path.join(this.config.outputDir, `comments_${timestamp}.json`), this.collectedComments);
    atomicWriteJson(path.join(this.config.outputDir, `matched_users_${timestamp}.json`), this.matchedUsers);
    atomicWriteJson(path.join(this.config.outputDir, `message_results_${timestamp}.json`), this.messageResults);
    return summary;
  }

  saveLedger(existingLedger) {
    const merged = new Map([...existingLedger, ...this.loadLedger()].map(item => [item.key, item]));
    for (const item of this.messageResults.filter(result => ['sent', 'unconfirmed'].includes(result.status))) merged.set(item.key, item);
    atomicWriteJson(path.join(this.config.outputDir, 'sent-ledger.json'), [...merged.values()]);
  }

  messageQuotaReached(sentCount) {
    return this.config.maxMessages > 0 && sentCount >= this.config.maxMessages;
  }

  trackDelivery(delivery, state) {
    if (delivery.sent || delivery.result?.status === 'unconfirmed') state.consecutiveOpenFailures = 0;
    if (delivery.sent) state.sentCount += 1;
    if (delivery.stop) state.stopAll = true;
    if (delivery.openFailure) {
      state.consecutiveOpenFailures += 1;
      if (state.consecutiveOpenFailures >= this.config.maxConsecutiveMessageFailures) {
        this.warnings.push('连续私信失败达到上限，已停止发送');
        state.stopAll = true;
      }
    }
  }

  normalizeVideoTarget(target) {
    if (typeof target === 'string') {
      return { url: target, searchKeyword: this.config.searchKeyword };
    }
    return {
      url: target.url,
      searchKeyword: target.searchKeyword || this.config.searchKeyword
    };
  }

  async deliverOne(user, ledger, sentCount) {
    const searchKeyword = user.searchKeyword || this.config.searchKeyword;
    const fingerprint = user.userFingerprint || this.userFingerprint(user);
    const key = user.key || this.ledgerKey(user, searchKeyword);
    user.key = key;
    user.userFingerprint = fingerprint;
    user.searchKeyword = searchKeyword;
    const quotaLabel = this.config.maxMessages > 0 ? this.config.maxMessages : '不限';
    const prior = priorDelivery(ledger, key, { userFingerprint: fingerprint, searchKeyword });
    if (prior === 'skip') {
      const result = {
        username: user.username, userId: user.userId, userLink: normalizeLink(user.userLink),
        key, userFingerprint: fingerprint, searchKeyword, status: 'skipped_duplicate'
      };
      this.messageResults.push(result);
      this.rememberLead(user, result);
      this.emit('running', `${user.username} 在“${searchKeyword}”下已发过，已跳过`, { leadUpdate: result });
      return { result, stop: false, sent: false, openFailure: false, attemptedSend: false };
    }
    if (prior === 'review') {
      const result = {
        username: user.username, userId: user.userId, userLink: normalizeLink(user.userLink),
        key, userFingerprint: fingerprint, searchKeyword, status: 'needs_review',
        error: '上次发送未确认，已跳过自动重发'
      };
      this.messageResults.push(result);
      this.rememberLead(user, result);
      this.emit('running', result.error, { leadUpdate: result });
      return { result, stop: false, sent: false, openFailure: false, attemptedSend: false };
    }
    this.messageAttempts += 1;
    this.setPhase(PHASES.MESSAGE, `命中用户，立即私信（已发送 ${sentCount}/${quotaLabel}）`);
    this.emit('running', `正在发送私信：${user.username}（已做 ${this.messageAttempts} 次，已发送 ${sentCount}/${quotaLabel}）`, {
      progress: this.config.maxMessages > 0 ? { current: sentCount, total: this.config.maxMessages } : undefined
    });
    const result = await this.sendMessage(user, this.config.messageTemplate, sentCount + 1, this.config.maxMessages || 0);
    this.messageResults.push(result);
    this.rememberLead(user, result);
    const existingIndex = ledger.findIndex(item => item.key === result.key);
    if (existingIndex >= 0) ledger[existingIndex] = { ...ledger[existingIndex], ...result };
    else ledger.push(result);
    this.saveLedger(ledger);
    const confirmed = sentCount + (result.status === 'sent' ? 1 : 0);
    this.emit('running', result.status === 'sent' ? `已发送给 ${user.username}` : (result.error || result.status), {
      leadUpdate: result,
      progress: this.config.maxMessages > 0 ? { current: confirmed, total: this.config.maxMessages } : undefined
    });
    if (result.status === 'blocked') {
      this.warnings.push('私信阶段触发访问限制，已停止发送');
      return { result, stop: true, sent: false, openFailure: false, attemptedSend: true };
    }
    const openFailure = result.status === 'failed'
      || (result.status === 'unavailable' && result.errorCode !== 'MESSAGE_RESTRICTED');
    return { result, stop: false, sent: result.status === 'sent', openFailure, attemptedSend: true };
  }

  async gatherAndSend() {
    await this.init();
    await this.openDouyinAndLogin();
    await this.verifyBoundAccount();
    await this.searchKeyword();
    const videoLinks = await this.getVideoLinks();
    const quotaLabel = this.config.maxMessages > 0 ? this.config.maxMessages : '不限';
    this.setPhase(PHASES.COLLECT, `开始采集，每采完一个视频就逐个私信（上限 ${quotaLabel}）`);
    const ledger = this.loadLedger();
    const seenUsers = new Set();
    const state = { sentCount: 0, consecutiveOpenFailures: 0, stopAll: false };

    for (let index = 0; index < videoLinks.length; index += 1) {
      if (state.stopAll || this.messageQuotaReached(state.sentCount)) break;
      this.throwIfAborted();
      const target = this.normalizeVideoTarget(videoLinks[index]);
      const result = await this.collectCommentsFromVideo(target.url, index + 1, videoLinks.length);
      this.videoResults.push(result);
      this.collectedComments = dedupeComments([...this.collectedComments, ...result.comments]);
      if (['blocked', 'login_required', 'aborted'].includes(result.status)) {
        if (result.status !== 'aborted') this.warnings.push(`视频 ${index + 1}: ${result.error}`);
        break;
      }

      const leads = uniqueUsers(result.comments).map(user => this.leadView(user, target.searchKeyword));
      const pending = [];
      for (const user of leads) {
        const fingerprint = user.userFingerprint || this.userFingerprint(user);
        const seenKey = `${target.searchKeyword}\u0000${fingerprint}`;
        if (seenUsers.has(seenKey)) continue;
        seenUsers.add(seenKey);
        this.rememberLead(user, {});
        pending.push(user);
      }
      if (pending.length) this.emit('running', `视频 ${index + 1} 采集完成，开始逐个私信 ${pending.length} 人`);
      for (const user of pending) {
        if (state.stopAll || this.messageQuotaReached(state.sentCount)) break;
        this.throwIfAborted();
        const delivery = await this.deliverOne(user, ledger, state.sentCount);
        this.trackDelivery(delivery, state);
        const pause = delivery.sent || delivery.result?.status === 'unconfirmed';
        if (pause && !state.stopAll && !this.messageQuotaReached(state.sentCount)) {
          await this.sleep(this.config.delayBetweenMessages + Math.floor(Math.random() * 1500));
        }
      }
    }

    this.saveLedger(ledger);
    this.timeFilter = {
      days: this.config.commentAgeDays,
      referenceTime: this.startedAt,
      eligible: this.collectedComments.length,
      unknownTime: this.scanStats.unknownTime
    };
    if (this.config.commentAgeDays && this.scanStats.unknownTime) {
      this.warnings.push(`${this.scanStats.unknownTime} 条评论无法确认发布时间，已排除，不参与私信`);
    }
    if (this.messageQuotaReached(state.sentCount)) {
      this.emit('running', `已发送 ${this.config.maxMessages} 条私信，停止采集`);
    }
  }

  async gatherCollectOnly() {
    await this.init();
    await this.openDouyinAndLogin();
    await this.verifyBoundAccount();
    await this.searchKeyword();
    const videoLinks = await this.getVideoLinks();
    this.setPhase(PHASES.COLLECT, `开始采集 ${videoLinks.length} 个视频`);
    for (let index = 0; index < videoLinks.length; index += 1) {
      this.throwIfAborted();
      const target = this.normalizeVideoTarget(videoLinks[index]);
      const result = await this.collectCommentsFromVideo(target.url, index + 1, videoLinks.length);
      result.searchKeyword = target.searchKeyword;
      this.videoResults.push(result);
      this.collectedComments = dedupeComments([
        ...this.collectedComments,
        ...result.comments.map(comment => ({ ...comment, searchKeyword: target.searchKeyword }))
      ]);
      if (['blocked', 'login_required', 'aborted'].includes(result.status)) {
        if (result.status !== 'aborted') this.warnings.push(`视频 ${index + 1}: ${result.error}`);
        break;
      }
    }
    this.throwIfAborted();
    this.setPhase(PHASES.FILTER, '正在筛选和去重用户');
    this.timeFilter = {
      days: this.config.commentAgeDays,
      referenceTime: this.startedAt,
      eligible: this.collectedComments.length,
      unknownTime: this.scanStats.unknownTime
    };
    if (this.config.commentAgeDays && this.scanStats.unknownTime) {
      this.warnings.push(`${this.scanStats.unknownTime} 条评论无法确认发布时间，已排除，不参与私信`);
    }
    this.matchedUsers = uniqueUsers(this.collectedComments).map(user => this.leadView(user, user.searchKeyword || this.config.searchKeyword));
    this.emit('running', `找到 ${this.matchedUsers.length} 个匹配用户`);
  }

  async gather() {
    await this.gatherAndSend();
  }

  async deliverMessages() {
    const ledger = this.loadLedger();
    const state = { sentCount: 0, consecutiveOpenFailures: 0, stopAll: false };
    for (let index = 0; index < this.matchedUsers.length; index += 1) {
      this.throwIfAborted();
      if (state.stopAll || this.messageQuotaReached(state.sentCount)) break;
      const user = this.matchedUsers[index];
      const delivery = await this.deliverOne(user, ledger, state.sentCount);
      this.trackDelivery(delivery, state);
      const pause = delivery.sent || delivery.result?.status === 'unconfirmed';
      if (pause && !state.stopAll && !this.messageQuotaReached(state.sentCount) && index < this.matchedUsers.length - 1) {
        await this.sleep(this.config.delayBetweenMessages + Math.floor(Math.random() * 1500));
      }
    }
    this.saveLedger(ledger);
    if (this.messageQuotaReached(state.sentCount)) {
      this.emit('running', `已发送 ${this.config.maxMessages} 条私信，停止发送`);
    }
  }

  finishSummary(finalStatus) {
    this.setPhase(PHASES.SAVE, '正在保存结果');
    const summary = this.saveResults(finalStatus);
    this.phase = finalStatus === 'ready_to_send' ? PHASES.REVIEW : PHASES.COMPLETE;
    const message = finalStatus === 'ready_to_send'
      ? (this.matchedUsers.length ? `采集完成，${this.matchedUsers.length} 个用户待确认发送` : '没有找到符合条件的用户')
      : finalStatus === 'completed' ? '任务完成' : '任务完成，但有异常需要查看';
    this.emit(finalStatus, message, {
      summary,
      leads: finalStatus === 'ready_to_send' ? this.matchedUsers.map(user => this.leadView(user)) : undefined
    });
    return summary;
  }

  async execute(task) {
    this.isRunning = true;
    try {
      return await task();
    } catch (error) {
      const finalStatus = error.code === 'ABORTED' ? 'aborted' : 'failed';
      if (error.code === 'BLOCKED') {
        this.retainBrowserOnExit = true;
        this.warnings.push(`${error.message}；浏览器已保留，请手动处理后重新开始采集`);
      } else if (error.code !== 'ABORTED') {
        this.warnings.push(error.message);
      }
      let summary;
      try { summary = this.saveResults(finalStatus); }
      catch (saveError) { this.warnings.push(`保存失败：${saveError.message}`); }
      this.emit(finalStatus, error.message, { errorCode: error.code || 'UNEXPECTED_ERROR', summary });
      if (error.code !== 'ABORTED') throw error;
      return summary;
    } finally {
      try { this.updatePendingStatuses(); }
      catch (error) { this.warnings.push(`名单状态保存失败：${error.message}`); }
      this.isRunning = false;
      clearInterval(this.heartbeatTimer);
      if (this.retainBrowserOnExit) {
        this.emit('waiting', '浏览器已保留，请在其中处理验证码或限制后再重新开始采集');
      } else {
        await this.close();
      }
    }
  }

  async run() {
    return this.execute(async () => {
      if (this.config.reviewBeforeSend) {
        await this.gatherCollectOnly();
        this.throwIfAborted();
        this.writePendingCampaign();
        return this.finishSummary('ready_to_send');
      }
      await this.gatherAndSend();
      this.throwIfAborted();
      const hasWarnings = this.warnings.length || this.videoResults.some(result => result.status !== 'success') ||
        this.messageResults.some(result => !['sent', 'skipped_duplicate'].includes(result.status));
      return this.finishSummary(hasWarnings ? 'completed_with_warnings' : 'completed');
    });
  }

  async runSend(leads, options = {}) {
    this.matchedUsers = (Array.isArray(leads) ? leads : []).map(lead => this.leadView(lead));
    return this.execute(async () => {
      await this.init();
      await this.openDouyinAndLogin();
      await this.verifyBoundAccount();
      this.releaseUnconfirmed(options.retryKeys || []);
      if (this.matchedUsers.length) await this.deliverMessages();
      const hasWarnings = this.warnings.length || this.messageResults.some(result => !['sent', 'skipped_duplicate'].includes(result.status));
      return this.finishSummary(hasWarnings ? 'completed_with_warnings' : 'completed');
    });
  }

  stop(reason = '用户停止任务', code = 'ABORTED') {
    if (!this.signal.aborted) {
      this.abortCode = code;
      this.abortMessage = reason;
      this.emit('stopping', reason);
      this.abortController.abort(reason);
    }
  }

  async close() {
    if (this.closePromise) return this.closePromise;
    this.closePromise = (async () => {
      clearInterval(this.heartbeatTimer);
      const browser = this.browser;
      this.browser = null;
      this.page = null;
      if (browser) await browser.close().catch(() => {});
    })();
    return this.closePromise;
  }
}

module.exports = DouyinCommentCollector;
module.exports.CollectorError = CollectorError;
module.exports.PHASES = PHASES;
module.exports.validateConfig = validateConfig;
module.exports.normalizeComment = normalizeComment;
module.exports.parseCommentTime = parseCommentTime;
module.exports.filterCommentsByTime = filterCommentsByTime;
module.exports.extractCommentsFromPayload = extractCommentsFromPayload;
module.exports.dedupeComments = dedupeComments;
module.exports.filterCommentsByKeywords = filterCommentsByKeywords;
module.exports.annotateMatches = annotateMatches;
module.exports.classifyPageState = classifyPageState;
module.exports.priorDelivery = priorDelivery;
module.exports.userFingerprint = userFingerprint;
module.exports.ledgerKeyFor = ledgerKeyFor;
module.exports.uniqueUsers = uniqueUsers;
module.exports.atomicWriteJson = atomicWriteJson;
module.exports.ensureProfileAvailable = ensureProfileAvailable;
module.exports.accountFingerprintFromCookies = accountFingerprintFromCookies;
