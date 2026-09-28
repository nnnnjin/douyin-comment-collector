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

启动后填写搜索词、评论筛选词、私信内容和数量限制。首次真实验证请把“本次最多私信”设为 `1`。

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

CLI 使用前复制 `config.example.js` 为 `config.js`。自动刷视频旧功能仍可通过 `npm run direct` 使用，但不属于本次重构的采集流程。

## 使用边界

- 遵守平台规则、隐私保护和反垃圾信息要求。
- 不要尝试绕过验证码或账号风控。
- 页面结构改变后，先查看 `run_*.json` 的错误状态，不要把空数据当成成功。

