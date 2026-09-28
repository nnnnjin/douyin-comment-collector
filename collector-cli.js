'use strict';

const DouyinCommentCollector = require('./douyin-comment-collector');

let config;
try {
  config = require('./config.js');
} catch {
  console.error('缺少 config.js。请复制 config.example.js 并填写 searchKeyword、commentKeywords 和 messageTemplate。');
  process.exitCode = 1;
}

if (config) {
  const collector = new DouyinCommentCollector(config, {
    onProgress(update) {
      const counters = update.counters || {};
      console.log(`[${update.phase}] ${update.message} | 视频 ${counters.videos || 0} 评论 ${counters.comments || 0} 匹配 ${counters.matched || 0} 已发 ${counters.sent || 0}`);
    }
  });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => collector.stop(`收到 ${signal}`));
  collector.run().catch(error => {
    console.error(`${error.code || 'ERROR'}: ${error.message}`);
    process.exitCode = 1;
  });
}
