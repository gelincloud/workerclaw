# Browser Bridge 使用指南

## 概述

智工坊 Chrome 扩展现在支持两种模式：

1. **云端模式** - 将登录态同步到智工坊平台，供云端 Agent 使用
2. **本地模式** - 通过本地 Daemon 直接操作本机 Chrome，无需同步登录态

一个扩展，两种用途！

## 安装扩展

1. 打开 Chrome，访问 `chrome://extensions/`
2. 开启「开发者模式」
3. 点击「加载已解压的扩展程序」
4. 选择 `20260310201629/chrome-extension` 目录

扩展安装后会显示：
- 智工坊连接状态
- 各平台登录态检测
- Browser Bridge 连接状态

## 模式一：云端同步（原有功能）

用于云端 Agent 使用您的登录态。

### 步骤

1. 点击扩展图标
2. 点击「从智工坊网页获取登录信息」
3. 在各平台（微博、知乎、小红书等）登录
4. 点击「同步到智工坊」

同步后，云端 Agent 即可使用这些登录态执行需要认证的操作。

## 模式二：本地 Browser Bridge（新功能）

直接使用本机 Chrome 的登录态，不上传到平台。

### 步骤

#### 1. 启动 Daemon

```bash
# 前台运行（调试用）
workerclaw daemon

# 后台运行
workerclaw daemon --detach

# 指定端口
workerclaw daemon --port=19825

# 停止后台进程
workerclaw daemon --stop
```

#### 2. 配置 WorkerClaw

在配置文件中添加：

```json
{
  "webCli": {
    "mode": "local",
    "local": {
      "port": 19825
    }
  }
}
```

#### 3. 确保扩展已连接

点击扩展图标，查看「Browser Bridge」状态显示「已连接」。

### 使用示例

```typescript
// 在 Agent 中使用
const result = await web_cli({
  site: 'browser',
  command: 'navigate',
  url: 'https://weibo.com',
});

// 获取 Cookie（直接从本机 Chrome 读取）
const cookies = await web_cli({
  site: 'cookies',
  command: 'get',
  domain: 'weibo.com',
});

// 执行 JavaScript
const title = await web_cli({
  site: 'browser',
  command: 'exec',
  code: 'document.title',
});

// 截图
const screenshot = await web_cli({
  site: 'browser',
  command: 'screenshot',
  fullPage: true,
});
```

## 功能对比

| 功能 | 云端模式 | 本地模式 |
|-----|---------|---------|
| 登录态来源 | 同步到平台 | 本机 Chrome |
| 执行位置 | 服务器端 | 本机 Chrome |
| 需要同步 | 是 | 否 |
| 实时性 | 取决于同步频率 | 实时 |
| 适用场景 | 云端 Docker Agent | 本地开发、敏感操作 |
| 网络要求 | 需要外网 | 完全离线可用 |

## 高级用法

### 操作用户当前标签页

```typescript
// 绑定当前用户正在浏览的标签页
const result = await web_cli({
  site: 'browser',
  command: 'bind-current',
  matchDomain: 'weibo.com',  // 可选：只匹配特定域名
});

// 然后就可以操作该标签页
await web_cli({
  site: 'browser',
  command: 'exec',
  code: 'document.querySelector(".send-btn").click()',
});
```

### 多工作空间

```typescript
// 使用不同的工作空间（独立的浏览器窗口）
const ws1 = 'task_001';

await web_cli({
  site: 'browser',
  command: 'navigate',
  url: 'https://weibo.com',
  workspace: ws1,
});
```

### 自动化窗口隔离

本地模式下的自动化操作会在独立的 Chrome 窗口中进行，不会干扰您正常的浏览。

- 窗口默认不聚焦（`focused: false`）
- 30 秒无操作自动关闭
- 完全隔离，不影响用户当前标签页

## 安全说明

1. **Daemon 安全**
   - 只监听 localhost
   - 拒绝非扩展来源的请求
   - 无 CORS 头，阻止浏览器跨域请求

2. **CDP 白名单**
   - 只允许安全的 CDP 命令
   - 禁止修改安全设置、执行危险操作

3. **登录态安全**
   - 本地模式登录态不上传
   - 扩展只能访问已授权的域名 Cookie

## 故障排除

### 扩展显示「未连接」

1. 确认 Daemon 已启动：`workerclaw daemon`
2. 检查端口是否被占用：`lsof -i :19825`
3. 查看扩展控制台是否有错误

### 登录态获取失败

1. 确认已在浏览器中登录目标网站
2. 检查扩展是否有该网站的 host_permissions
3. 尝试刷新页面后重试

### Daemon 启动失败

1. 检查端口是否被占用
2. 尝试使用其他端口：`workerclaw daemon --port=19826`
3. 查看详细日志

## 开发调试

### 查看 Daemon 日志

```bash
# 前台运行时日志直接输出
workerclaw daemon

# 后台运行时查看日志
# (日志输出到 stdout，可重定向到文件)
workerclaw daemon > daemon.log 2>&1 &
```

### 查看扩展日志

1. 打开 `chrome://extensions/`
2. 找到智工坊扩展
3. 点击「service worker」查看后台日志

### 测试 Daemon 连接

```bash
# 测试 Daemon 是否运行
curl http://localhost:19825/ping

# 预期返回
{"ok":true,"extensionConnected":true,"version":"3.0.0"}
```

## 配置参考

### WebCliConfig

```typescript
interface WebCliConfig {
  /** 模式: platform | local */
  mode: 'platform' | 'local';
  
  /** 平台 API URL（platform 模式） */
  platformUrl?: string;  // 默认: https://www.miniabc.top
  
  /** 本地配置（local 模式） */
  local?: {
    port?: number;      // 默认: 19825
    host?: string;      // 默认: localhost
    timeout?: number;   // 默认: 30000ms
  };
}
```

### DaemonConfig

```typescript
interface DaemonConfig {
  port?: number;        // 默认: 19825
  host?: string;        // 默认: localhost
  idleTimeout?: number; // 默认: 4小时
}
```
