'use strict';

/** 评论采集器命令行配置示例。复制为 config.js 后运行 npm run cli。 */
module.exports = {
  // 先在桌面界面准备浏览器，再把 accounts/accounts.json 中对应的 id 填到这里。
  profileId: 'legacy',
  searchKeyword: '健身',
  // 也可以写多个搜索词：searchKeywords: ['健身', '减脂']
  // 桌面程序会先停在名单确认。命令行默认采集后直接发送。
  reviewBeforeSend: false,
  commentKeywords: ['想要', '怎么', '求推荐'],
  messageTemplate: '你好，看到你对这个话题感兴趣，我这里有一些经验可以分享。',
  maxVideos: 5,
  // 评论发布时间：0 不限，10/20/30/365 天以内；时间不明时排除。
  commentAgeDays: 0,
  maxCommentsPerVideo: 50,
  delayBetweenMessages: 10000,
  pageTimeout: 30000,
  emptyScrollLimit: 3,
  maxConsecutiveMessageFailures: 3,
  maxMessages: 0,
  headless: false
};
