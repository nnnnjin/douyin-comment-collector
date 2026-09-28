'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { atomicWriteJson, CollectorError, ensureProfileAvailable } = require('./douyin-comment-collector');

function cleanLabel(value) {
  return String(value || '').trim().slice(0, 40);
}

function accountIdFromUrl(rawUrl) {
  try {
    const match = new URL(rawUrl).pathname.match(/^\/user\/([^/]+)/);
    if (!match || match[1] === 'self') return '';
    return decodeURIComponent(match[1]);
  } catch {
    return '';
  }
}

async function detectLoggedInAccount(page) {
  const cookies = await page.cookies().catch(() => []);
  const hasSession = cookies.some(cookie => /^(sessionid|sessionid_ss|sid_guard)$/.test(cookie.name) && cookie.value);
  if (!hasSession) return null;

  const visibleLogin = await page.evaluate(() => Array.from(document.querySelectorAll('button, [role="button"], a'))
    .some(element => element.offsetParent !== null && /^(登录|扫码登录)$/.test((element.textContent || '').trim())))
    .catch(() => true);
  if (visibleLogin) return null;

  const fromPage = await page.evaluate(() => {
    const selectors = [
      '[data-e2e="user-info"] a[href*="/user/"]',
      '[data-e2e="user-avatar"] a[href*="/user/"]',
      'header a[href*="/user/"]',
      'nav a[href*="/user/"]',
      'a[href*="/user/"] img'
    ];
    for (const selector of selectors) {
      const element = document.querySelector(selector);
      const link = element?.closest?.('a[href*="/user/"]') || element;
      if (link?.href) {
        return {
          href: link.href,
          nickname: (link.getAttribute('aria-label') || link.textContent || element?.getAttribute?.('alt') || '').trim()
        };
      }
    }
    return null;
  }).catch(() => null);

  let accountId = accountIdFromUrl(fromPage?.href || '');
  let nickname = fromPage?.nickname || '';
  if (!accountId) {
    await page.goto('https://www.douyin.com/user/self', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await new Promise(resolve => setTimeout(resolve, 1200));
    accountId = accountIdFromUrl(page.url());
    if (!nickname) {
      nickname = await page.evaluate(() => {
        const candidate = document.querySelector('[data-e2e="user-title"], h1, [class*="nickname"]');
        return (candidate?.textContent || document.title.split('-')[0] || '').trim();
      }).catch(() => '');
    }
  }
  return accountId ? { accountId, nickname: nickname || `账号 ${accountId.slice(-6)}` } : null;
}

class AccountProfileStore {
  constructor(runtimeRoot) {
    this.runtimeRoot = runtimeRoot;
    this.accountsRoot = path.join(runtimeRoot, 'accounts');
    this.registryPath = path.join(this.accountsRoot, 'accounts.json');
    fs.mkdirSync(this.accountsRoot, { recursive: true });
  }

  load() {
    try {
      const data = JSON.parse(fs.readFileSync(this.registryPath, 'utf8'));
      return Array.isArray(data.profiles) ? data.profiles : [];
    } catch {
      return [];
    }
  }

  save(profiles) {
    atomicWriteJson(this.registryPath, { version: 1, profiles });
  }

  list() {
    return this.load().map(profile => ({ ...profile, ready: Boolean(profile.accountId) }));
  }

  ensureLegacyProfile(legacyProfileDir) {
    if (!fs.existsSync(legacyProfileDir)) return;
    const profiles = this.load();
    if (profiles.some(profile => profile.id === 'legacy')) return;
    profiles.unshift({
      id: 'legacy',
      label: '原浏览器',
      accountId: '',
      nickname: '',
      profileDir: legacyProfileDir,
      updatedAt: new Date().toISOString()
    });
    this.save(profiles);
  }

  get(profileId) {
    return this.load().find(profile => profile.id === profileId) || null;
  }

  createDraft(label) {
    const normalizedLabel = cleanLabel(label);
    if (!normalizedLabel) throw new CollectorError('INVALID_PROFILE_LABEL', '请输入浏览器名称，例如“账号A浏览器”');
    const id = crypto.randomUUID();
    return { id, label: normalizedLabel, profileDir: path.join(this.accountsRoot, id, 'browser-data') };
  }

  bind({ profileId, label, profileDir, accountId, nickname }) {
    if (!accountId) throw new CollectorError('ACCOUNT_ID_MISSING', '已登录，但无法识别抖音账号身份');
    const profiles = this.load();
    const existing = profiles.find(profile => profile.id === profileId);
    const duplicate = profiles.find(profile => profile.accountId === accountId && profile.id !== profileId);
    if (duplicate) {
      throw new CollectorError('ACCOUNT_ALREADY_BOUND', `该抖音账号已绑定到“${duplicate.label}”，不能再绑定另一个浏览器`);
    }
    if (existing?.accountId && existing.accountId !== accountId) {
      throw new CollectorError('ACCOUNT_MISMATCH', `“${existing.label}”已绑定其他抖音账号，请在打开的浏览器中切回原账号`);
    }
    const next = {
      id: profileId,
      label: cleanLabel(label || existing?.label),
      profileDir: profileDir || existing?.profileDir,
      accountId,
      nickname: cleanLabel(nickname) || existing?.nickname || `账号 ${accountId.slice(-6)}`,
      updatedAt: new Date().toISOString()
    };
    const updated = profiles.filter(profile => profile.id !== profileId);
    updated.push(next);
    this.save(updated);
    return { ...next, ready: true };
  }
}

class AccountProfileManager {
  constructor(runtimeRoot, onUpdate = () => {}) {
    this.store = new AccountProfileStore(runtimeRoot);
    this.onUpdate = onUpdate;
    this.browser = null;
    this.abortController = null;
  }

  list() { return this.store.list(); }

  async prepare({ profileId, label }) {
    if (this.browser || this.abortController) throw new CollectorError('PREPARATION_RUNNING', '已有浏览器正在准备');
    const existing = profileId ? this.store.get(profileId) : null;
    if (profileId && !existing) throw new CollectorError('PROFILE_NOT_FOUND', '选择的浏览器配置不存在');
    const draft = existing || this.store.createDraft(label);
    this.abortController = new AbortController();
    const signal = this.abortController.signal;
    const notify = (status, message, extra = {}) => this.onUpdate({
      profileId: draft.id, status, message, ...extra
    });

    try {
      notify('starting', `正在打开“${draft.label}”`);
      const puppeteer = require('puppeteer');
      const executablePath = await puppeteer.executablePath();
      if (!fs.existsSync(executablePath)) throw new CollectorError('BROWSER_MISSING', '缺少配套 Chrome，请运行 npm run browser:install');
      ensureProfileAvailable(draft.profileDir);
      this.browser = await puppeteer.launch({
        headless: false,
        executablePath,
        userDataDir: draft.profileDir,
        args: ['--disable-blink-features=AutomationControlled', '--window-size=1400,900']
      });
      const pages = await this.browser.pages();
      const page = pages[0] || await this.browser.newPage();
      await page.goto('https://www.douyin.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
      notify('waiting_login', '请在打开的浏览器中登录要绑定的抖音账号');
      const deadline = Date.now() + 300000;
      while (Date.now() < deadline) {
        if (signal.aborted) throw new CollectorError('ABORTED', '已取消浏览器准备');
        const identity = await detectLoggedInAccount(page);
        if (identity) {
          if (existing?.accountId && existing.accountId !== identity.accountId) {
            notify('account_mismatch', `当前登录账号与“${existing.label}”绑定账号不一致，请切回 ${existing.nickname || '原账号'}`);
          } else {
            const profile = this.store.bind({
              profileId: draft.id,
              label: draft.label,
              profileDir: draft.profileDir,
              accountId: identity.accountId,
              nickname: identity.nickname
            });
            notify('ready', `已绑定：${profile.label} ↔ ${profile.nickname}`, { profile });
            return profile;
          }
        }
        await new Promise((resolve, reject) => {
          const onAbort = () => {
            clearTimeout(timer);
            reject(new CollectorError('ABORTED', '已取消浏览器准备'));
          };
          const timer = setTimeout(() => {
            signal.removeEventListener('abort', onAbort);
            resolve();
          }, 2000);
          signal.addEventListener('abort', onAbort, { once: true });
        });
      }
      throw new CollectorError('LOGIN_TIMEOUT', '等待账号登录超时');
    } finally {
      const browser = this.browser;
      this.browser = null;
      this.abortController = null;
      if (browser) await browser.close().catch(() => {});
    }
  }

  async cancel() {
    if (this.abortController && !this.abortController.signal.aborted) this.abortController.abort();
    if (this.browser) await this.browser.close().catch(() => {});
  }
}

module.exports = { AccountProfileStore, AccountProfileManager, detectLoggedInAccount, accountIdFromUrl };
