# 抖音评论采集和私信工具

桌面程序会搜索视频、采集网页正常加载的评论、按关键词筛选用户，并在确认发送结果后记录私信状态。程序不会绕过登录、验证码或平台访问限制。

## 环境

- Node.js 22.12 或更高版本（低于 27）
- macOS
- Puppeteer 配套的 Chrome for Testing

## 安装与启动

```bash
npm install
npm run browser:install
npm start
```

如果官方浏览器下载在国内网络较慢，可安装同版本镜像文件：

```bash
npx puppeteer browsers install chrome --base-url https://cdn.npmmirror.com/binaries/chrome-for-testing
```

启动后先准备截流浏览器：

1. 输入一个容易识别的浏览器名称，例如“账号A浏览器”。
2. 点击“准备新浏览器”，在打开的独立浏览器中登录对应抖音账号。
3. 程序打开本人主页，用抖音用户 ID 保存一一绑定关系，并自动关闭准备窗口。
4. 以后先从下拉框选择该浏览器；采集前程序会再次核对这个用户 ID，发现串号立即停止。

原有 `browser-data` 会作为“原浏览器（待确认账号）”出现，点击“检查所选”完成首次绑定。只保存过 Cookie 哈希的旧绑定也需要重新检查。同一抖音账号不能同时绑定两个浏览器配置。

随后添加搜索词、评论筛选词和私信内容。桌面程序先采集名单，确认勾选后再发送。首次真实验证保持“本次最多私信”为 `1`。只有会话里出现这条私信才记为已发出。

## 状态与输出

界面持续显示当前阶段、最近活动时间和采集/匹配/发送数量。结果保存在 `output`：

- `run_*.json`：本次运行摘要和逐视频状态
- `comments_*.json`：采集到的评论
- `matched_users_*.json`：关键词匹配并按用户去重后的列表
- `message_results_*.json`：发送、跳过和失败状态
- `sent-ledger.json`：跨运行发送去重记录

视频状态包括 `success`、`no_comments`、`selector_failed`、`login_required`、`blocked`、`timeout` 和 `aborted`。出现验证码、登录失效或连续私信失败时，程序会停止相关流程并保留已有结果。

## 命令

```bash
npm start          # 启动桌面程序
npm run cli        # 使用 config.js 运行同一采集流程
npm run check      # 语法检查和单元测试
npm run test:browser # 配套浏览器与本地页面集成测试
npm run build      # 构建 macOS 应用
```

CLI 使用前必须先在桌面界面完成浏览器账号绑定，再复制 `config.example.js` 为 `config.js`，并填写对应的 `profileId`。自动刷视频旧功能仍可通过 `npm run direct` 使用，但不属于本次重构的采集流程。

## 使用边界

- 遵守平台规则、隐私保护和反垃圾信息要求。
- 不要尝试绕过验证码或账号风控。
- 不要在已绑定的浏览器配置中切换抖音账号；需要其他账号时新建独立浏览器。
- 页面结构改变后，先查看 `run_*.json` 的错误状态，不要把空数据当成成功。
