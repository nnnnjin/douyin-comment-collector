'use strict';

/** 评论采集器命令行配置示例。复制为 config.js 后运行 npm run cli。 */
module.exports = {
  // 先在桌面界面准备浏览器，再把 accounts/accounts.json 中对应的 id 填到这里。
  profileId: 'legacy',
  searchKeyword: '健身',
  commentKeywords: ['想要', '怎么', '求推荐'],
  messageTemplate: '你好，看到你对这个话题感兴趣，我这里有一些经验可以分享。',
  maxVideos: 5,
  maxCommentsPerVideo: 30,
  delayBetweenMessages: 10000,
  pageTimeout: 30000,
  emptyScrollLimit: 3,
  maxConsecutiveMessageFailures: 3,
  maxMessages: 0,
  headless: false
};
