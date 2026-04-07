# Browser Bridge 设计文档

## 概述

整合现有的「智工坊登录态同步」扩展与「Browser Bridge」功能，实现一个统一的 Chrome 扩展：

1. **云端模式** - 将登录态同步到智工坊平台，供云端 Agent 使用
2. **本地模式** - 通过本地 Daemon 直接操作本机 Chrome，无需同步登录态

## 架构设计

```
┌─────────────────────────────────────────────────────────────────┐
│                    智工坊 Chrome 扩展 (统一)                      │
├─────────────────────────────────────────────────────────────────┤
│  功能模块:                                                        │
│  ├── 智工坊认证 (JWT/Token)                                      │
│  ├── 登录态同步 (云端模式) → miniabc.top API                     │
│  └── Browser Bridge (本地模式) → 本地 Daemon                     │
├─────────────────────────────────────────────────────────────────┤
│  权限:                                                            │
│  ├── cookies        - Cookie 读取 (云端同步 + 本地 Bridge)       │
│  ├── debugger       - CDP 协议 (Browser Bridge 核心)             │
│  ├── tabs           - 标签页管理                                  │
│  ├── activeTab      - 当前标签页                                  │
│  ├── storage        - 本地存储                                    │
│  ├── scripting      - 脚本注入 (从网页获取登录信息)               │
│  └── alarms         - 定时任务 (Daemon 连接保活)                  │
└─────────────────────────────────────────────────────────────────┘
              │                              │
              ▼                              ▼
     ┌─────────────────┐            ┌─────────────────┐
     │  智工坊平台      │            │  本地 Daemon    │
     │  miniabc.top    │            │  localhost:19825│
     └─────────────────┘            └─────────────────┘
              │                              │
              ▼                              ▼
     ┌─────────────────┐            ┌─────────────────┐
     │ 云端 Agent      │            │ WorkerClaw      │
     │ (Docker 容器)   │            │ (本地进程)      │
     └─────────────────┘            └─────────────────┘
```

## 核心改造

### 1. manifest.json 更新

```json
{
  "name": "智工坊 - 登录态同步 & Browser Bridge",
  "permissions": [
    "cookies",
    "debugger",    // 新增：Browser Bridge 核心
    "tabs",        // 新增：标签页管理
    "activeTab",
    "storage",
    "scripting",
    "alarms"       // 新增：Daemon 保活
  ],
  "host_permissions": [
    "<all_urls>"   // 扩展为所有 URL（Browser Bridge 需要）
  ]
}
```

### 2. 扩展文件结构

```
chrome-extension/
├── manifest.json          # 权限配置
├── background.js          # Service Worker (整合版)
├── popup.html             # 弹窗界面
├── popup.js               # 弹窗逻辑
├── bridge-protocol.js     # Browser Bridge 协议 (新增)
├── bridge-cdp.js          # CDP 执行器 (新增)
└── icons/
    └── ...
```

### 3. WorkerClaw 配置

```typescript
// config.ts
interface WebCliConfig {
  /** 模式: platform (平台代理) | local (本机浏览器) */
  mode: 'platform' | 'local';
  
  /** 平台 API URL（platform 模式） */
  platformUrl?: string;
  
  /** 本地 Daemon 配置（local 模式） */
  local?: {
    port?: number;           // 默认 19825
    autoStart?: boolean;     // 自动启动 Daemon
    connectTimeout?: number; // 连接超时
  };
}
```

## 使用场景对比

| 场景 | 推荐模式 | 原因 |
|-----|---------|------|
| 云端 Docker Agent | `platform` | 无本机 Chrome |
| 本地开发测试 | `local` | 实时、零配置 |
| 敏感操作 | `local` | 登录态不上传 |
| 无外网环境 | `local` | 完全离线 |
| 多账号批量 | `platform` | 统一管理 |

## 安全机制

1. **Daemon 认证**
   - Origin 检查（必须是 chrome-extension://）
   - 自定义 Header（X-MiniABC-Daemon）
   - 无 CORS 头（阻止浏览器跨域）

2. **CDP 白名单**
   - 只允许安全的 CDP 命令
   - 禁止危险操作（如修改安全设置）

3. **窗口隔离**
   - 自动化操作在独立窗口
   - 30 秒空闲自动关闭

## 实施步骤

1. ✅ 扩展 manifest 添加 `debugger` 权限
2. ✅ 添加 Browser Bridge 模块
3. ✅ 实现本地 Daemon
4. ✅ 改造 WorkerClaw web_cli
5. ✅ 添加配置界面
