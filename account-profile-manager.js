// Copyright (c) 2026 wu. All rights reserved.
// Commercial use requires prior written permission from the copyright holder.
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  atomicWriteJson, CollectorError, ensureProfileAvailable
} = require('./douyin-comment-collector');

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

async function readDouyinCookies(page) {
  if (!page || (typeof page.isClosed === 'function' && page.isClosed())) return [];
  try {
    const client = await page.createCDPSession();
    try {
      const { cookies } = await client.send('Network.getAllCookies');
      return (cookies || []).filter(cookie => /douyin\.com|snssdk\.com/i.test(cookie.domain || ''));
    } finally {
      await client.detach().catch(() => {});
    }
  } catch {
    return page.cookies('https://www.douyin.com/').catch(() => page.cookies().catch(() => []));
  }
}

async function hasLoginSession(page) {
  const cookies = await readDouyinCookies(page);
  return cookies.some(cookie => /^(sessionid|sessionid_ss|sid_guard|sid_tt)$/.test(cookie.name) && cookie.value);
}

function identityFromProfilePayload(payload) {
  const user = payload?.user || payload?.user_info || payload?.data?.user || null;
  if (!user || typeof user !== 'object') return null;
  const accountId = String(user.sec_uid || user.secUid || '').trim();
  if (!accountId || accountId === 'self') return null;
  const nickname = String(user.nickname || user.nick_name || '').trim();
  return { accountId, nickname: nickname || `账号 ${accountId.slice(-4)}` };
}

function identityFromRequestUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (!/\/aweme\/v1\/web\/(aweme\/post|aweme\/favorite|user\/profile)/.test(url.pathname)) return '';
    return String(url.searchParams.get('sec_user_id') || '').trim();
  } catch {
    return '';
  }
}

async function waitForSelfIdentity(page, timeoutMs = 15000) {
  let resolved = null;
  let fallbackId = '';
  const onResponse = async response => {
    if (resolved) return;
    const url = response.url();
    if (/\/aweme\/v1\/web\/user\/profile\/self\/?/.test(url)) {
      try {
        const identity = identityFromProfilePayload(await response.json());
        if (identity) resolved = identity;
      } catch { /* ignore non-json */ }
      return;
    }
    const fromQuery = identityFromRequestUrl(url);
    if (fromQuery) fallbackId = fromQuery;
  };
  page.on('response', onResponse);
  try {
    const alreadyOnSelf = /\/user\/self(?:\/|$)/.test(page.url());
    if (!alreadyOnSelf && !accountIdFromUrl(page.url())) {
      await page.goto('https://www.douyin.com/user/self', { waitUntil: 'domcontentloaded', timeout: 30000 });
    } else if (alreadyOnSelf) {
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    }
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline && !resolved) {
      const fromUrl = accountIdFromUrl(page.url());
      if (fromUrl) {
        const nickname = await page.evaluate(() => {
          const text = document.querySelector('h1, [data-e2e="user-info"] h1, [data-e2e="user-title"]')?.textContent?.trim() || '';
          return text && text.length <= 40 ? text : '';
        }).catch(() => '');
        resolved = { accountId: fromUrl, nickname: nickname || `账号 ${fromUrl.slice(-4)}` };
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    if (!resolved && fallbackId) {
      const nickname = await page.evaluate(() => {
        const text = document.querySelector('h1, [data-e2e="user-info"] h1, [data-e2e="user-title"]')?.textContent?.trim() || '';
        return text && text.length <= 40 ? text : '';
      }).catch(() => '');
      resolved = { accountId: fallbackId, nickname: nickname || `账号 ${fallbackId.slice(-4)}` };
    }
    return resolved;
  } finally {
    page.off('response', onResponse);
  }
}

async function detectLoggedInAccount(page) {
  if (!(await hasLoginSession(page))) return null;
  const fromUrl = accountIdFromUrl(page.url());
  if (fromUrl) {
    const nickname = await page.evaluate(() => {
      const text = document.querySelector('h1, [data-e2e="user-info"] h1, [data-e2e="user-title"]')?.textContent?.trim() || '';
      return text && text.length <= 40 ? text : '';
    }).catch(() => '');
    return { accountId: fromUrl, nickname: nickname || `账号 ${fromUrl.slice(-4)}` };
  }
  return waitForSelfIdentity(page);
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
    return this.load().map(profile => ({
      ...profile,
      ready: Boolean(profile.accountId) && !String(profile.accountId).startsWith('cookie:')
    }));
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
    const legacyBinding = String(existing?.accountId || '').startsWith('cookie:');
    if (existing?.accountId && !legacyBinding && existing.accountId !== accountId) {
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
    this.browserClosedByUser = false;
  }

  list() { return this.store.list(); }

  sleep(ms, signal) {
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        clearTimeout(timer);
        reject(new CollectorError('ABORTED', '已取消浏览器准备'));
      };
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  isBrowserOpen() {
    return Boolean(this.browser?.connected) && !this.browserClosedByUser;
  }

  async prepare({ profileId, label }) {
    if (this.browser || this.abortController) throw new CollectorError('PREPARATION_RUNNING', '已有浏览器正在准备');
    const existing = profileId ? this.store.get(profileId) : null;
    if (profileId && !existing) throw new CollectorError('PROFILE_NOT_FOUND', '选择的浏览器配置不存在');
    const draft = existing || this.store.createDraft(label);
    this.abortController = new AbortController();
    this.browserClosedByUser = false;
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
      this.browser.on('disconnected', () => {
        this.browserClosedByUser = true;
      });
      const pages = await this.browser.pages();
      let page = pages[0] || await this.browser.newPage();
      await page.goto('https://www.douyin.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
      notify('waiting_login', '请在打开的浏览器中登录；每 10 秒检查一次，未登录时不会改动页面');

      while (true) {
        if (signal.aborted) throw new CollectorError('ABORTED', '已取消浏览器准备');
        if (!this.isBrowserOpen()) {
          notify('browser_closed', '浏览器已关闭，账号状态未改动，可重新点击检查所选');
          throw new CollectorError('BROWSER_CLOSED', '浏览器已关闭');
        }

        if (page.isClosed()) {
          const openPages = await this.browser.pages().catch(() => []);
          page = openPages.find(item => !item.isClosed()) || null;
          if (!page) {
            notify('browser_closed', '浏览器已关闭，账号状态未改动，可重新点击检查所选');
            throw new CollectorError('BROWSER_CLOSED', '浏览器已关闭');
          }
        }

        let loggedIn = false;
        try {
          loggedIn = await hasLoginSession(page);
        } catch (error) {
          if (!this.isBrowserOpen() || /Target closed|Session closed|Protocol error|browser has disconnected/i.test(error.message || '')) {
            notify('browser_closed', '浏览器已关闭，账号状态未改动，可重新点击检查所选');
            throw new CollectorError('BROWSER_CLOSED', '浏览器已关闭');
          }
          throw error;
        }

        if (!loggedIn) {
          notify('waiting_login', '尚未登录，继续等待；可在浏览器中登录，或直接关闭浏览器后重新检查');
          await this.sleep(10000, signal);
          continue;
        }

        notify('waiting_login', '已登录，正在识别账号...');
        let identity = null;
        try {
          identity = await detectLoggedInAccount(page);
        } catch (error) {
          if (!this.isBrowserOpen() || /Target closed|Session closed|Protocol error|browser has disconnected/i.test(error.message || '')) {
            notify('browser_closed', '浏览器已关闭，账号状态未改动，可重新点击检查所选');
            throw new CollectorError('BROWSER_CLOSED', '浏览器已关闭');
          }
          throw error;
        }

        if (!identity) {
          notify('waiting_login', '已登录，但还没读到账号信息；10 秒后重试，其间不会改动你的登录状态');
          await this.sleep(10000, signal);
          continue;
        }

        const legacyBinding = String(existing?.accountId || '').startsWith('cookie:');
        if (existing?.accountId && !legacyBinding && existing.accountId !== identity.accountId) {
          notify('account_mismatch', `当前登录账号与“${existing.label}”绑定账号不一致，请切回 ${existing.nickname || '原账号'}`);
          await this.sleep(10000, signal);
          continue;
        }

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
    } catch (error) {
      if (signal.aborted || error.code === 'ABORTED') throw new CollectorError('ABORTED', '已取消浏览器准备');
      if (error.code === 'BROWSER_CLOSED' || this.browserClosedByUser) {
        throw new CollectorError('BROWSER_CLOSED', '浏览器已关闭');
      }
      throw error;
    } finally {
      const browser = this.browser;
      this.browser = null;
      this.abortController = null;
      if (browser?.connected) await browser.close().catch(() => {});
      this.browserClosedByUser = false;
    }
  }

  async cancel() {
    if (this.abortController && !this.abortController.signal.aborted) this.abortController.abort();
    if (this.browser?.connected) await this.browser.close().catch(() => {});
  }
}

module.exports = {
  AccountProfileStore,
  AccountProfileManager,
  detectLoggedInAccount,
  hasLoginSession,
  identityFromProfilePayload,
  identityFromRequestUrl,
  accountIdFromUrl
};
