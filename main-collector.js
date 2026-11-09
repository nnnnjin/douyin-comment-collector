// Copyright (c) 2026 wu. All rights reserved.
// Commercial use requires prior written permission from the copyright holder.
'use strict';

const { app, BrowserWindow, ipcMain, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const DouyinCommentCollector = require('./douyin-comment-collector');
const { AccountProfileManager } = require('./account-profile-manager');

let mainWindow = null;
let activeTask = null;
let accountManager = null;
let activePreparation = null;

function runtimeRoot() {
  return app.isPackaged ? app.getPath('userData') : __dirname;
}

function pendingPath() {
  return path.join(runtimeRoot(), 'output', 'pending-send.json');
}

function readPending() {
  try {
    const data = JSON.parse(fs.readFileSync(pendingPath(), 'utf8'));
    if (!data || !Array.isArray(data.leads) || !data.config) return null;
    return data;
  } catch {
    return null;
  }
}

function profileReady(profile) {
  return Boolean(profile?.accountId) && !String(profile.accountId).startsWith('cookie:');
}

function sendUpdate(update) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('collector:update', update);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 820,
    minWidth: 760,
    minHeight: 680,
    title: '抖音评论采集和私信工具',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    }
  });
  mainWindow.loadFile(path.join(__dirname, 'comment-collector.html'));
  mainWindow.on('closed', () => {
    if (activeTask) activeTask.stop('窗口已关闭');
    if (activePreparation) accountManager.cancel();
    mainWindow = null;
  });
}

ipcMain.handle('collector:start', async (_event, config) => {
  if (activeTask) throw new Error('已有任务正在运行');
  if (activePreparation) throw new Error('请先完成或取消浏览器账号准备');
  const profile = accountManager?.store.get(String(config.profileId || ''));
  if (!profileReady(profile)) throw new Error('请先选择并准备一个已绑定抖音账号的浏览器');
  const runId = crypto.randomUUID();
  const task = new DouyinCommentCollector({
    ...config,
    profileId: profile.id,
    profileLabel: profile.label,
    expectedAccountId: profile.accountId,
    accountNickname: profile.nickname,
    outputDir: path.join(runtimeRoot(), 'output'),
    profileDir: profile.profileDir
  }, { runId, onProgress: sendUpdate });
  activeTask = task;
  setImmediate(async () => {
    try {
      await task.run();
    } catch (error) {
      console.error(`[${runId}] 采集任务失败:`, error);
    } finally {
      if (activeTask === task) activeTask = null;
    }
  });
  return { runId };
});

ipcMain.handle('collector:stop', async (_event, runId) => {
  const task = activeTask;
  if (!task || (runId && task.runId !== runId)) return { stopped: false };
  task.stop();
  await task.close();
  return { stopped: true };
});

ipcMain.handle('collector:state', () => ({
  running: Boolean(activeTask), runId: activeTask?.runId || null,
  phase: activeTask?.phase || null, counters: activeTask?.counters() || null
}));

ipcMain.handle('collector:open-output', async () => {
  const outputDir = path.join(runtimeRoot(), 'output');
  fs.mkdirSync(outputDir, { recursive: true });
  const error = await shell.openPath(outputDir);
  return { ok: !error, error };
});

ipcMain.handle('collector:pending', () => readPending());

ipcMain.handle('collector:send', async (_event, payload = {}) => {
  if (activeTask) throw new Error('已有任务正在运行');
  if (activePreparation) throw new Error('请先完成或取消浏览器账号准备');
  const pending = readPending();
  if (!pending) throw new Error('没有可发送的名单，请先采集');
  const profile = accountManager?.store.get(String(pending.config.profileId || ''));
  if (!profileReady(profile)) throw new Error('请先重新检查要用来发送的浏览器账号');
  const selected = new Set((payload.userKeys || []).map(String));
  const leads = pending.leads.filter(lead => selected.has(String(lead.key)));
  if (leads.length === 0) throw new Error('请至少选择一个用户');
  const retryKeys = (payload.retryKeys || []).map(String).filter(key => selected.has(key));
  const runId = crypto.randomUUID();
  const task = new DouyinCommentCollector({
    ...pending.config,
    reviewBeforeSend: false,
    profileId: profile.id,
    profileLabel: profile.label,
    expectedAccountId: profile.accountId,
    accountNickname: profile.nickname,
    outputDir: path.join(runtimeRoot(), 'output'),
    profileDir: profile.profileDir
  }, { runId, onProgress: sendUpdate });
  activeTask = task;
  setImmediate(async () => {
    try {
      await task.runSend(leads, { retryKeys });
    } catch (error) {
      console.error(`[${runId}] 私信任务失败:`, error);
    } finally {
      if (activeTask === task) activeTask = null;
    }
  });
  return { runId };
});

ipcMain.handle('accounts:list', () => accountManager?.list() || []);

ipcMain.handle('accounts:prepare', async (_event, options = {}) => {
  if (activeTask) throw new Error('采集任务运行中，不能切换浏览器账号');
  if (activePreparation) throw new Error('已有浏览器正在准备');
  const preparation = accountManager.prepare(options);
  activePreparation = preparation;
  try {
    return await preparation;
  } catch (error) {
    if (mainWindow && !mainWindow.isDestroyed()) {
      const status = error.code === 'ABORTED'
        ? 'cancelled'
        : error.code === 'BROWSER_CLOSED'
          ? 'browser_closed'
          : 'failed';
      mainWindow.webContents.send('account:update', {
        profileId: options.profileId || null,
        status,
        message: error.message,
        errorCode: error.code || 'ACCOUNT_PREPARATION_FAILED'
      });
    }
    throw error;
  } finally {
    if (activePreparation === preparation) activePreparation = null;
  }
});

ipcMain.handle('accounts:cancel-prepare', async () => {
  if (!activePreparation) return { cancelled: false };
  await accountManager.cancel();
  return { cancelled: true };
});

app.whenReady().then(() => {
  accountManager = new AccountProfileManager(runtimeRoot(), update => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('account:update', update);
  });
  accountManager.store.ensureLegacyProfile(path.join(runtimeRoot(), 'browser-data'));
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('before-quit', event => {
  if ((activeTask && !activeTask.signal.aborted) || activePreparation) {
    event.preventDefault();
    const task = activeTask;
    const preparation = activePreparation;
    if (task) task.stop('应用正在退出');
    Promise.allSettled([
      task ? task.close() : Promise.resolve(),
      preparation ? accountManager.cancel() : Promise.resolve(),
      preparation || Promise.resolve()
    ]).finally(() => {
      if (activeTask === task) activeTask = null;
      if (activePreparation === preparation) activePreparation = null;
      app.quit();
    });
  }
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
