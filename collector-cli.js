'use strict';

const DouyinCommentCollector = require('./douyin-comment-collector');
const { AccountProfileStore } = require('./account-profile-manager');
const path = require('path');

let config;
try {
  config = require('./config.js');
} catch {
  console.error('缺少 config.js。请复制 config.example.js 并填写 searchKeyword、commentKeywords 和 messageTemplate。');
  process.exitCode = 1;
}

if (config) {
  const store = new AccountProfileStore(__dirname);
  store.ensureLegacyProfile(path.join(__dirname, 'browser-data'));
  const profile = store.get(String(config.profileId || ''));
  if (!profile?.accountId) {
    console.error('config.js 中的 profileId 尚未绑定账号。请先运行 npm start，在界面准备浏览器账号。');
    process.exitCode = 1;
    return;
  }
  const collector = new DouyinCommentCollector({
    ...config,
    profileId: profile.id,
    profileLabel: profile.label,
    expectedAccountId: profile.accountId,
    accountNickname: profile.nickname,
    profileDir: profile.profileDir,
    outputDir: path.join(__dirname, 'output')
  }, {
    onProgress(update) {
      const counters = update.counters || {};
      console.log(`[${update.phase}] ${update.message} | 已查看 ${counters.viewed || 0} 采集 ${counters.collected || 0} 私信 ${counters.messaged || 0} 成功 ${counters.sent || 0}`);
    }
  });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => collector.stop(`收到 ${signal}`));
  collector.run().catch(error => {
    console.error(`${error.code || 'ERROR'}: ${error.message}`);
    process.exitCode = 1;
  });
}
