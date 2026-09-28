'use strict';

const { app, BrowserWindow, ipcMain, shell } = require('electron');
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
  if (!profile?.accountId) throw new Error('请先选择并准备一个已绑定抖音账号的浏览器');
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
  const error = await shell.openPath(path.join(runtimeRoot(), 'output'));
  return { ok: !error, error };
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
      mainWindow.webContents.send('account:update', {
        profileId: options.profileId || null,
        status: error.code === 'ABORTED' ? 'cancelled' : 'failed',
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
