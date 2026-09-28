'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PHASES = Object.freeze({
  STARTUP: 'startup', LOGIN: 'login', SEARCH: 'search', DISCOVERY: 'discovery',
  COLLECT: 'collect', FILTER: 'filter', MESSAGE: 'message', SAVE: 'save', COMPLETE: 'complete'
});
const VIDEO_STATUSES = new Set(['success', 'no_comments', 'selector_failed', 'login_required', 'blocked', 'timeout', 'aborted']);
const DEFAULT_CONFIG = Object.freeze({
  searchKeyword: '', commentKeywords: [], messageTemplate: '', maxVideos: 10,
  maxCommentsPerVideo: 50, delayBetweenMessages: 10000, pageTimeout: 30000,
  emptyScrollLimit: 3, maxConsecutiveMessageFailures: 3, maxMessages: 0,
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

function validateConfig(input = {}) {
  const searchKeyword = String(input.searchKeyword || '').trim();
  const messageTemplate = String(input.messageTemplate || '').trim();
  const commentKeywords = Array.isArray(input.commentKeywords)
    ? [...new Set(input.commentKeywords.map(value => String(value).trim()).filter(Boolean))]
    : [];
  if (!searchKeyword) throw new CollectorError('INVALID_CONFIG', '请输入搜索关键词');
  if (commentKeywords.length === 0) throw new CollectorError('INVALID_CONFIG', '请至少添加一个评论筛选关键词');
  if (!messageTemplate) throw new CollectorError('INVALID_CONFIG', '请输入私信内容');
  return {
    ...DEFAULT_CONFIG, searchKeyword, commentKeywords, messageTemplate,
    maxVideos: clampInteger(input.maxVideos, DEFAULT_CONFIG.maxVideos, 1, 50),
    maxCommentsPerVideo: clampInteger(input.maxCommentsPerVideo, DEFAULT_CONFIG.maxCommentsPerVideo, 1, 200),
    delayBetweenMessages: clampInteger(input.delayBetweenMessages, DEFAULT_CONFIG.delayBetweenMessages, 5000, 120000),
    pageTimeout: clampInteger(input.pageTimeout, DEFAULT_CONFIG.pageTimeout, 10000, 90000),
    emptyScrollLimit: clampInteger(input.emptyScrollLimit, DEFAULT_CONFIG.emptyScrollLimit, 1, 10),
    maxConsecutiveMessageFailures: clampInteger(input.maxConsecutiveMessageFailures, DEFAULT_CONFIG.maxConsecutiveMessageFailures, 1, 10),
    maxMessages: clampInteger(input.maxMessages, DEFAULT_CONFIG.maxMessages, 0, 500),
    headless: Boolean(input.headless),
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
    return {
      videos: this.videoResults.length,
      comments: this.collectedComments.length,
      matched: this.matchedUsers.length,
      sent: this.messageResults.filter(result => result.status === 'sent').length,
      failed: this.videoResults.filter(result => result.status !== 'success').length +
        this.messageResults.filter(result => !['sent', 'skipped_duplicate'].includes(result.status)).length
    };
  }

  emit(status, message, extra = {}) {
    this.lastActivityAt = new Date().toISOString();
    this.onProgress({
      runId: this.runId, phase: this.phase, status, progress: extra.progress || null,
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
    fs.mkdirSync(this.config.profileDir, { recursive: true });
    const lockPath = path.join(this.config.profileDir, 'SingletonLock');
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
      try { fs.unlinkSync(path.join(this.config.profileDir, name)); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
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
        runId: this.runId, phase: this.phase, status: 'heartbeat', progress: null,
        counters: this.counters(), message: '任务运行中', errorCode: null, lastActivityAt: this.lastActivityAt
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
    return this.page.evaluate(() => {
      const text = (document.body?.innerText || '').slice(0, 20000);
      if (/验证码|访问频繁|操作频繁|安全验证|滑块验证|账号存在风险/.test(text)) return 'blocked';
      if (/扫码登录|密码登录|验证码登录/.test(text)) return 'login_required';
      return 'ready';
    }).catch(() => 'closed');
  }

  async checkLoginStatus() {
    if (!this.page || this.page.isClosed()) return false;
    const cookies = await this.page.cookies().catch(() => []);
    const hasSessionCookie = cookies.some(cookie => /^(sessionid|sessionid_ss|sid_guard)$/.test(cookie.name) && cookie.value);
    const evidence = await this.page.evaluate(() => {
      const loginPrompt = Array.from(document.querySelectorAll('button, [role="button"], a'))
        .some(element => /^(登录|扫码登录)$/.test((element.textContent || '').trim()) && element.offsetParent !== null);
      const accountElement = document.querySelector(
        '[data-e2e="user-info"], [data-e2e="user-avatar"], a[href*="/user/self"], a[href*="/user/"] img'
      );
      return { loginPrompt, hasAccountElement: Boolean(accountElement) };
    }).catch(() => ({ loginPrompt: true, hasAccountElement: false }));
    return hasSessionCookie && !evidence.loginPrompt && evidence.hasAccountElement;
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

  async searchKeyword() {
    this.setPhase(PHASES.SEARCH, `正在搜索“${this.config.searchKeyword}”`);
    const url = `https://www.douyin.com/search/${encodeURIComponent(this.config.searchKeyword)}?type=video`;
    const state = await this.navigate(url, '打开搜索结果');
    if (state === 'login_required') throw new CollectorError('LOGIN_REQUIRED', '登录状态已失效');
    await this.page.waitForFunction(() => document.querySelectorAll('a[href*="/video/"]').length > 0 || /未找到|暂无相关/.test(document.body?.innerText || ''),
      { timeout: Math.min(15000, this.config.pageTimeout) }).catch(() => {});
  }

  async getVideoLinks() {
    this.setPhase(PHASES.DISCOVERY, '正在获取视频列表');
    const videos = new Set();
    let stagnant = 0;
    while (videos.size < this.config.maxVideos && stagnant < 3) {
      this.throwIfAborted();
      const before = videos.size;
      const links = await this.page.evaluate(() => Array.from(document.querySelectorAll('a[href*="/video/"]'))
        .filter(element => element.offsetParent !== null).map(element => element.href));
      for (const link of links) { if (videos.size >= this.config.maxVideos) break; videos.add(normalizeLink(link)); }
      stagnant = videos.size === before ? stagnant + 1 : 0;
      this.emit('running', `已发现 ${videos.size} 个视频`, { progress: { current: videos.size, total: this.config.maxVideos } });
      if (videos.size >= this.config.maxVideos) break;
      await this.page.evaluate(() => window.scrollBy(0, Math.max(window.innerHeight, 700)));
      await this.sleep(1200);
    }
    if (videos.size === 0) throw new CollectorError('NO_VIDEOS', '没有找到视频；可能是页面结构变化、搜索无结果或登录失效');
    return [...videos].slice(0, this.config.maxVideos);
  }

  async openCommentPanel() {
    const clicked = await this.page.evaluate(() => {
      const candidates = Array.from(document.querySelectorAll('[data-e2e="comment-icon"], [aria-label*="评论"], button, [role="button"]'));
      const target = candidates.find(element => {
        if (element.offsetParent === null) return false;
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
        try { elements = Array.from(document.querySelectorAll(selector)).filter(element => element.offsetParent !== null); }
        catch { elements = []; }
        if (elements.length > 0) break;
      }
      return elements.map(element => {
        const link = element.querySelector('a[href*="/user/"]');
        const nameElement = element.querySelector('[data-e2e="comment-user-name"], [data-e2e="user-name"], a[href*="/user/"]');
        const textElement = element.querySelector('[data-e2e="comment-text"], [data-e2e="comment-content"], p, [dir="auto"]');
        return { username: (nameElement?.textContent || '').trim(), content: (textElement?.textContent || '').trim(), userLink: link?.href || '' };
      });
    });
    return rawComments.map(raw => normalizeComment(raw, { videoUrl, videoIndex, source: 'dom' })).filter(Boolean);
  }

  async scrollComments() {
    return this.page.evaluate(() => {
      const candidates = Array.from(document.querySelectorAll('[data-e2e="comment-list"], [role="list"], div'))
        .filter(element => element.offsetParent !== null && element.scrollHeight > element.clientHeight + 100)
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
    try {
      this.emit('running', `正在打开视频 ${videoIndex}/${totalVideos}`, { progress: { current: videoIndex, total: totalVideos } });
      const state = await this.withTimeout(this.navigate(videoUrl, `打开视频 ${videoIndex}`), this.config.pageTimeout * 2,
        'VIDEO_TIMEOUT', `视频 ${videoIndex} 处理超时`);
      if (state === 'login_required') return this.videoResult(videoUrl, videoIndex, 'login_required', [], started, '登录状态已失效');
      await this.openCommentPanel();
      let comments = [];
      let emptyRounds = 0;
      let previousCount = 0;
      while (comments.length < this.config.maxCommentsPerVideo && emptyRounds < this.config.emptyScrollLimit) {
        this.throwIfAborted();
        if (await this.detectPageState() === 'blocked') return this.videoResult(videoUrl, videoIndex, 'blocked', comments, started, '出现验证码或访问限制');
        comments = dedupeComments([...comments, ...networkComments, ...await this.extractDomComments(videoUrl, videoIndex)]);
        emptyRounds = comments.length === previousCount ? emptyRounds + 1 : 0;
        previousCount = comments.length;
        this.emit('running', `视频 ${videoIndex}/${totalVideos}：已采集 ${comments.length} 条评论`, {
          progress: { current: videoIndex, total: totalVideos, comments: comments.length, emptyRounds }
        });
        if (comments.length >= this.config.maxCommentsPerVideo) break;
        const scrolled = await this.scrollComments();
        if (!scrolled && comments.length === 0) emptyRounds = this.config.emptyScrollLimit;
        await this.sleep(1000);
      }
      comments = comments.slice(0, this.config.maxCommentsPerVideo);
      if (comments.length > 0) return this.videoResult(videoUrl, videoIndex, 'success', comments, started);
      const hasCommentSurface = await this.page.evaluate(() => Boolean(document.querySelector(
        '[data-e2e="comment-list"], [data-e2e="comment-item"], [aria-label*="评论"]'))).catch(() => false);
      return this.videoResult(videoUrl, videoIndex, hasCommentSurface ? 'no_comments' : 'selector_failed', [], started,
        hasCommentSurface ? '评论区没有可采集评论' : '未识别到评论区结构');
    } catch (error) {
      const status = this.signal.aborted || error.code === 'ABORTED'
        ? 'aborted'
        : error.code === 'BLOCKED' ? 'blocked' : 'timeout';
      return this.videoResult(videoUrl, videoIndex, status, [], started, error.message);
    } finally { if (this.page && !this.page.isClosed()) this.page.off('response', onResponse); }
  }

  videoResult(videoUrl, videoIndex, status, comments, started, error = '') {
    if (!VIDEO_STATUSES.has(status)) status = 'selector_failed';
    return { videoUrl: safeUrl(videoUrl), videoIndex, status, commentCount: comments.length, comments, durationMs: Date.now() - started, error };
  }

  loadLedger() {
    try {
      const ledger = JSON.parse(fs.readFileSync(path.join(this.config.outputDir, 'sent-ledger.json'), 'utf8'));
      return Array.isArray(ledger) ? ledger : [];
    } catch { return []; }
  }

  ledgerKey(user) {
    return crypto.createHash('sha256').update(user.userId || normalizeLink(user.userLink)).digest('hex');
  }

  async clickByText(pattern) {
    return this.page.evaluate(source => {
      const regex = new RegExp(source);
      const target = Array.from(document.querySelectorAll('button, [role="button"], a'))
        .find(element => element.offsetParent !== null && regex.test((element.textContent || '').trim()));
      if (!target) return false;
      target.click();
      return true;
    }, pattern.source);
  }

  async sendMessage(user, message, index, total) {
    const key = this.ledgerKey(user);
    const base = { username: user.username, userId: user.userId, userLink: normalizeLink(user.userLink), key };
    try {
      const state = await this.navigate(user.userLink, `打开用户 ${index}/${total}`);
      if (state === 'blocked') return { ...base, status: 'blocked', error: '出现验证码或访问限制' };
      if (state === 'login_required') return { ...base, status: 'failed', error: '登录状态已失效' };
      if (!await this.clickByText(/^私信$/)) return { ...base, status: 'unavailable', error: '未找到可用的私信按钮' };
      await this.sleep(800);
      const input = await this.page.$('textarea[placeholder*="消息"], input[placeholder*="消息"], [contenteditable="true"][role="textbox"]');
      if (!input) return { ...base, status: 'unavailable', error: '未找到消息输入框' };
      const beforeCount = await this.page.evaluate(text => Array.from(document.querySelectorAll(
        '[data-e2e*="message"], [role="log"] *, [class*="message"]')).filter(element => (element.textContent || '').trim() === text).length, message);
      await input.click();
      await input.type(message, { delay: 35 });
      await this.page.keyboard.press('Enter');
      await this.page.waitForFunction((text, previous) => {
        const count = Array.from(document.querySelectorAll('[data-e2e*="message"], [role="log"] *, [class*="message"]'))
          .filter(element => (element.textContent || '').trim() === text).length;
        const editor = document.querySelector('textarea[placeholder*="消息"], input[placeholder*="消息"], [contenteditable="true"][role="textbox"]');
        const value = editor ? ('value' in editor ? editor.value : editor.textContent) : '';
        return count > previous && !String(value || '').trim();
      }, { timeout: 10000 }, message, beforeCount);
      return { ...base, status: 'sent', sentAt: new Date().toISOString() };
    } catch (error) {
      return { ...base, status: error.code === 'BLOCKED' ? 'blocked' : 'failed', error: error.message };
    }
  }

  saveResults(finalStatus = 'completed') {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const summary = {
      runId: this.runId, status: finalStatus, startedAt: this.startedAt, finishedAt: new Date().toISOString(),
      searchKeyword: this.config.searchKeyword, commentKeywords: this.config.commentKeywords,
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
    const merged = new Map(existingLedger.map(item => [item.key, item]));
    for (const item of this.messageResults.filter(result => result.status === 'sent')) merged.set(item.key, item);
    atomicWriteJson(path.join(this.config.outputDir, 'sent-ledger.json'), [...merged.values()]);
  }

  async run() {
    this.isRunning = true;
    let finalStatus = 'completed';
    try {
      await this.init();
      await this.openDouyinAndLogin();
      await this.searchKeyword();
      const videoLinks = await this.getVideoLinks();
      this.setPhase(PHASES.COLLECT, `开始采集 ${videoLinks.length} 个视频`);
      for (let index = 0; index < videoLinks.length; index += 1) {
        this.throwIfAborted();
        const result = await this.collectCommentsFromVideo(videoLinks[index], index + 1, videoLinks.length);
        this.videoResults.push(result);
        this.collectedComments = dedupeComments([...this.collectedComments, ...result.comments]);
        if (['blocked', 'login_required', 'aborted'].includes(result.status)) {
          if (result.status !== 'aborted') this.warnings.push(`视频 ${index + 1}: ${result.error}`);
          break;
        }
      }
      this.throwIfAborted();
      this.setPhase(PHASES.FILTER, '正在筛选和去重用户');
      this.matchedUsers = uniqueUsers(filterCommentsByKeywords(this.collectedComments, this.config.commentKeywords));
      this.emit('running', `找到 ${this.matchedUsers.length} 个匹配用户`);
      this.setPhase(PHASES.MESSAGE, '开始自动发送私信');
      const ledger = this.loadLedger();
      const sentKeys = new Set(ledger.map(item => item.key));
      let consecutiveFailures = 0;
      let attempted = 0;
      for (let index = 0; index < this.matchedUsers.length; index += 1) {
        this.throwIfAborted();
        if (this.config.maxMessages > 0 && attempted >= this.config.maxMessages) break;
        const user = this.matchedUsers[index];
        const key = this.ledgerKey(user);
        if (sentKeys.has(key)) {
          this.messageResults.push({ username: user.username, userId: user.userId, userLink: normalizeLink(user.userLink), key, status: 'skipped_duplicate' });
          continue;
        }
        attempted += 1;
        this.emit('running', `正在发送私信 ${attempted}/${this.config.maxMessages || this.matchedUsers.length}`, {
          progress: { current: attempted, total: this.config.maxMessages || this.matchedUsers.length }
        });
        const result = await this.sendMessage(user, this.config.messageTemplate, attempted, this.matchedUsers.length);
        this.messageResults.push(result);
        if (result.status === 'sent') { sentKeys.add(result.key); consecutiveFailures = 0; }
        else consecutiveFailures += 1;
        if (result.status === 'blocked' || consecutiveFailures >= this.config.maxConsecutiveMessageFailures) {
          this.warnings.push(result.status === 'blocked' ? '私信阶段触发访问限制，已停止发送' : '连续私信失败达到阈值，已停止发送');
          break;
        }
        await this.sleep(this.config.delayBetweenMessages + Math.floor(Math.random() * 1500));
      }
      this.saveLedger(ledger);
      if (this.videoResults.some(result => result.status !== 'success') ||
          this.messageResults.some(result => !['sent', 'skipped_duplicate'].includes(result.status))) finalStatus = 'completed_with_warnings';
      this.setPhase(PHASES.SAVE, '正在保存结果');
      const summary = this.saveResults(finalStatus);
      this.phase = PHASES.COMPLETE;
      this.emit(finalStatus, finalStatus === 'completed' ? '任务完成' : '任务完成，但有异常需要查看', { summary });
      return summary;
    } catch (error) {
      finalStatus = error.code === 'ABORTED' ? 'aborted' : 'failed';
      if (error.code !== 'ABORTED') this.warnings.push(error.message);
      let summary;
      try { summary = this.saveResults(finalStatus); }
      catch (saveError) { this.warnings.push(`保存失败：${saveError.message}`); }
      this.emit(finalStatus, error.message, { errorCode: error.code || 'UNEXPECTED_ERROR', summary });
      if (error.code !== 'ABORTED') throw error;
      return summary;
    } finally {
      this.isRunning = false;
      clearInterval(this.heartbeatTimer);
      await this.close();
    }
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
module.exports.extractCommentsFromPayload = extractCommentsFromPayload;
module.exports.dedupeComments = dedupeComments;
module.exports.filterCommentsByKeywords = filterCommentsByKeywords;
module.exports.uniqueUsers = uniqueUsers;
module.exports.atomicWriteJson = atomicWriteJson;
