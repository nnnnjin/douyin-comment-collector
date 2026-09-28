'use strict';

const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const crypto = require('crypto');
const DouyinCommentCollector = require('./douyin-comment-collector');

let mainWindow = null;
let activeTask = null;

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
    mainWindow = null;
  });
}

ipcMain.handle('collector:start', async (_event, config) => {
  if (activeTask) throw new Error('已有任务正在运行');
  const runId = crypto.randomUUID();
  const runtimeRoot = app.isPackaged ? app.getPath('userData') : __dirname;
  const task = new DouyinCommentCollector({
    ...config,
    outputDir: path.join(runtimeRoot, 'output'),
    profileDir: path.join(runtimeRoot, 'browser-data')
  }, { runId, onProgress: sendUpdate });
  activeTask = task;
  setImmediate(async () => {
    try {
      await task.run();
    } catch (error) {
      sendUpdate({
        runId, phase: task.phase, status: 'failed', progress: null,
        counters: task.counters(), message: error.message,
        errorCode: error.code || 'UNEXPECTED_ERROR', lastActivityAt: new Date().toISOString()
      });
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
  const runtimeRoot = app.isPackaged ? app.getPath('userData') : __dirname;
  const error = await shell.openPath(path.join(runtimeRoot, 'output'));
  return { ok: !error, error };
});

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('before-quit', event => {
  if (activeTask && !activeTask.signal.aborted) {
    event.preventDefault();
    const task = activeTask;
    task.stop('应用正在退出');
    task.close().finally(() => {
      if (activeTask === task) activeTask = null;
      app.quit();
    });
  }
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
