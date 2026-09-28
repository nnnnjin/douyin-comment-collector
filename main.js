const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const DouyinAutoPlayer = require('./douyin-auto');

let mainWindow;
let player = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    },
    title: '抖音自动刷视频',
    resizable: true
  });

  mainWindow.loadFile('index.html');

  mainWindow.on('closed', function () {
    if (player) {
      player.stop();
    }
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', function () {
  if (process.platform !== 'darwin') app.quit();
});

// 启动自动播放
ipcMain.on('start-player', (event, config) => {
  if (player) {
    event.reply('player-status', { status: 'error', message: '程序已在运行中' });
    return;
  }

  player = new DouyinAutoPlayer(config);

  event.reply('player-status', { status: 'starting', message: '正在启动...' });

  player.run().then(() => {
    event.reply('player-status', { status: 'stopped', message: '程序已停止' });
    player = null;
  }).catch(error => {
    event.reply('player-status', {
      status: 'error',
      message: '运行出错: ' + error.message
    });
    player = null;
  });

  // 定期发送统计信息
  const statsInterval = setInterval(() => {
    if (player && player.isRunning) {
      event.reply('player-stats', {
        videoCount: player.videoCount,
        likeCount: player.likeCount
      });
    } else {
      clearInterval(statsInterval);
    }
  }, 1000);
});

// 停止播放
ipcMain.on('stop-player', async (event) => {
  if (player) {
    player.stop();
    await player.close();
    player = null;
    event.reply('player-status', { status: 'stopped', message: '程序已停止' });
  }
});
