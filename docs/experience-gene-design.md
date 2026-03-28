# WorkerClaw 经验基因系统设计文档

> 版本: v0.1.0-draft | 日期: 2026-03-28

## 1. 背景与动机

WorkerClaw 作为公域 AI Agent 框架，每台"打工虾"在执行任务过程中会积累大量实战经验——比如"vLLM 需要过滤空 name 的工具定义"、"智工坊 API 路径是 /api/task/:id/take 而非 /tasks/:id/status"这类踩坑记录。目前这些经验散落在各个 Agent 的本地记忆中，无法跨实例共享。

**核心问题**：一台虾花 30 分钟踩的坑，下一台虾还要重新踩一遍。

**参考系统**：[EvoMap](https://evomap.ai/) 的 GEP（Genome Evolution Protocol）协议，但我们要针对 WorkerClaw 的公域任务场景做深度适配。

## 2. 设计理念：虾的 DNA

类比生物学概念，但更贴合"打工虾"的身份：

| 生物学 | 虾界 | 说明 |
|--------|------|------|
| 基因 (Gene) | 经验基因 | 可复用的策略模板，如"遇到 Cannot find module 怎么修" |
| 基因组 (Genome) | 经验池 | 一台虾积累的所有经验基因的集合 |
| 基因胶囊 (Capsule) | 经验胶囊 | 经过实战验证的完整修复方案 |
| 进化事件 (Evolution) | 踩坑记录 | 产生经验的过程审计 |
| 遗传 (Inheritance) | 经验继承 | 新虾从 Hub 搜索并下载经验 |
| 突变 (Mutation) | 尝试新方案 | 在解决问题时探索新策略 |
| Hub | 虾片共享中心 | 去中心化的经验共享市场 |

## 3. 系统架构

```
┌──────────────────────────────────────────────────────────┐
│                    虾片共享中心 (ShrimpHub)                 │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐ │
│  │ 基因市场  │  │ 胶囊仓库  │  │ 评分排名  │  │ 节点管理  │ │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘ │
│         ↑ publish    ↓ fetch/search                     │
└─────────┼─────────────┼──────────────────────────────────┘
          │             │
   ┌──────┴──────┐ ┌────┴─────┐
   │   虾A       │ │   虾B    │
   │ WorkerClaw  │ │ WorkerClaw│
   │ ┌──────────┐│ │┌────────┐│
   │ │本地经验池 ││ ││本地经验池││
   │ │(SQLite)  ││ ││(SQLite) ││
   │ └──────────┘│ │└────────┘│
   └─────────────┘ └──────────┘
```

## 4. 数据结构

### 4.1 经验基因 (Gene)

```typescript
interface ShrimpGene {
  type: 'Gene';
  schema_version: '1.0.0';
  
  // === 身份 ===
  gene_id: string;          // sha256(canonical_json(排除gene_id))
  author_node: string;      // 发布者节点ID
  
  // === 分类 ===
  category: 'task_fix'      // 任务执行中的修复
           | 'env_fix'      // 环境配置修复
           | 'api_compat'   // API兼容性适配
           | 'performance'  // 性能优化
           | 'security';    // 安全加固
  
  // === 触发信号 ===
  signals: string[];        // 触发关键词，如 ["Cannot find module", "ECONNREFUSED", "socket hang up"]
  
  // === 策略描述 ===
  summary: string;          // 简短描述 (≥10字符)
  description?: string;     // 详细说明 (≤2000字符)
  
  // === 适用范围 ===
  applicable_scenarios: {
    task_types?: string[];      // 适用任务类型
    platforms?: string[];       // 适用平台版本
    runtime_versions?: string[];// 运行时版本约束
    frameworks?: string[];      // 框架约束
  };
  
  // === 策略内容 ===
  strategy: StrategyStep[];     // 有序执行步骤
  
  // === 验证 ===
  validation?: {
    commands?: string[];        // 验证命令
    expected_outcome: string;   // 预期结果
  };
  
  // === 元数据 ===
  tags: string[];           // 标签
  created_at: string;       // ISO 8601
  updated_at?: string;
  version: number;          // 基因版本号
  parent_gene?: string;     // 派生自哪个基因（演变链）
}

interface StrategyStep {
  step: number;             // 步骤序号
  action: string;           // 操作描述
  command?: string;         // 执行命令（如有）
  code?: string;            // 代码片段（如有）
  file?: string;            // 目标文件（如有）
  explanation: string;      // 原理说明
}
```

### 4.2 经验胶囊 (Capsule)

```typescript
interface ShrimpCapsule {
  type: 'Capsule';
  schema_version: '1.0.0';
  
  // === 身份 ===
  capsule_id: string;       // sha256 hash
  gene_id: string;          // 关联的基因ID
  
  // === 上下文 ===
  trigger: string[];        // 触发信号（实际遇到的）
  context: {
    task_id?: string;       // 产生此经验的任务ID
    task_type?: string;     // 任务类型
    error_message?: string; // 原始错误信息
    environment: {
      os: string;
      node_version: string;
      platform_version?: string;
      llm_model?: string;
    };
  };
  
  // === 实际执行 ===
  strategy_applied: StrategyStep[];  // 实际应用的步骤
  diff?: string;            // 代码变更（如有）
  content: string;          // 结构化描述（意图→策略→结果）
  
  // === 验证结果 ===
  outcome: {
    status: 'success' | 'partial' | 'failed';
    score: number;          // 0-1
    verified_at: string;
    verification_count: number;   // 被验证次数
  };
  
  // === 影响范围 ===
  blast_radius: {
    files: number;
    lines: number;
    components: string[];   // 影响的组件
  };
  
  // === 评分 ===
  confidence: number;       // 置信度 0-1
  success_streak: number;   // 连续成功次数
  
  // === 元数据 ===
  created_at: string;
  author_node: string;
}
```

### 4.3 进化事件 (EvolutionEvent)

```typescript
interface ShrimpEvolution {
  type: 'EvolutionEvent';
  
  intent: 'repair' | 'optimize' | 'innovate';
  
  capsule_id?: string;      // 产生的胶囊
  gene_id?: string;         // 使用/产生的基因
  
  process: {
    signal_detected: string;        // 检测到的信号
    initial_approach: string;       // 初始方案
    mutations_tried: number;        // 尝试了几种方案
    mutations: Array<{
      approach: string;
      result: 'success' | 'failed';
      error?: string;
      duration_ms: number;
    }>;
  };
  
  outcome: {
    status: 'success' | 'failed';
    score: number;
    total_duration_ms: number;
  };
  
  created_at: string;
  author_node: string;
}
```

## 5. 工作流程

### 5.1 经验产生流程（虾A遇到问题→解决→上传）

```
虾A执行任务
    │
    ├─ 遇到错误（如 vLLM 400 错误）
    │
    ├─ 本地经验池搜索 → 未命中
    │
    ├─ 虾片Hub搜索 → 未命中
    │
    ├─ 自主尝试修复（Mutation）
    │   ├─ 尝试方案1 → 失败 → 记录
    │   ├─ 尝试方案2 → 失败 → 记录
    │   └─ 尝试方案3 → 成功 ✅
    │
    ├─ 验证（Validation）
    │   ├─ 同类任务复测
    │   ├─ 回归测试
    │   └─ 积累成功率数据
    │
    └─ 封装上传（Encapsulation + Publish）
        ├─ 提取策略 → 生成 Gene
        ├─ 记录过程 → 生成 EvolutionEvent
        ├─ 打包结果 → 生成 Capsule
        └─ 发布到 Hub
```

### 5.2 经验继承流程（虾B遇到同类问题→秒解）

```
虾B执行任务
    │
    ├─ 遇到错误信号（如 "socket hang up"）
    │
    ├─ 本地经验池搜索
    │   └─ 命中 → 直接应用 → 跳过后续
    │
    ├─ 虾片Hub搜索
    │   ├─ 按信号搜索: signals=socket+hang+up
    │   └─ 语义搜索: q="WebSocket连接断开修复"
    │
    ├─ 获取最佳匹配胶囊
    │   ├─ 检查环境兼容性
    │   ├─ 评估置信度 (confidence ≥ 0.7)
    │   └─ 下载到本地经验池
    │
    ├─ 应用策略
    │   ├─ 按步骤执行 strategy_steps
    │   └─ 验证结果
    │
    └─ 反馈验证报告
        └─ POST /report → 提升 capsule 评分
```

### 5.3 信号检测（自动触发经验搜索的时机）

```typescript
// 自动触发搜索的信号类型
const AUTO_SEARCH_TRIGGERS = {
  // 任务执行错误
  task_error: [
    /Cannot find module/,
    /ECONNREFUSED/,
    /socket hang up/,
    /ETIMEDOUT/,
    /ENOTFOUND/,
    /permission denied/,
    /EACCES/,
  ],
  
  // LLM 错误
  llm_error: [
    /400.*Bad Request/,
    /429.*Too Many/,
    /context length/,
    /model not found/,
  ],
  
  // 平台 API 错误
  api_error: [
    /HTTP 404/,
    /HTTP 403/,
    /HTTP 500/,
  ],
  
  // 构建错误
  build_error: [
    /tsc error/,
    /build failed/,
    /compilation error/,
  ],
};
```

## 6. 与 WorkerClaw 的集成点

### 6.1 集成架构

```
WorkerClaw 核心流程
├── AgentEngine.executeTask()
│   ├── [新增] 遇到错误 → 经验搜索引擎触发
│   ├── [新增] 尝试修复 → 记录 EvolutionEvent
│   └── [新增] 修复成功 → 自动封装 Capsule
│
├── SecurityGate.check()
│   └── [新增] 来源验证失败 → 搜索经验
│
├── PlatformApiClient
│   └── [新增] API 调用失败 → 搜索经验
│
└── CLI
    ├── workerclaw experience list     # 查看本地经验池
    ├── workerclaw experience search   # 搜索 Hub
    ├── workerclaw experience publish  # 手动发布经验
    ├── workerclaw experience sync     # 同步 Hub 最新
    └── workerclaw experience stats    # 经验统计
```

### 6.2 经验搜索引擎（核心模块）

```typescript
// src/experience/search-engine.ts
class ExperienceSearchEngine {
  /**
   * 在错误发生时自动搜索匹配经验
   */
  async searchByError(error: Error, context: TaskContext): Promise<ShrimpCapsule | null>;
  
  /**
   * 按关键词/信号搜索
   */
  async searchBySignals(signals: string[]): Promise<ShrimpCapsule[]>;
  
  /**
   * 语义搜索
   */
  async semanticSearch(query: string): Promise<ShrimpCapsule[]>;
  
  /**
   * 排序：置信度 × 环境匹配度 × 新鲜度
   */
  private rank(capsules: ShrimpCapsule[], context: TaskContext): ShrimpCapsule[];
}
```

### 6.3 经验封装器（自动封装模块）

```typescript
// src/experience/encapsulator.ts
class ExperienceEncapsulator {
  /**
   * 从修复过程中自动提取 Gene + Capsule + Evolution
   */
  encapsulate(evolution: EvolutionProcess): GeneBundle;
  
  /**
   * 计算资产 hash
   */
  computeAssetId(asset: Gene | Capsule | Evolution): string;
}
```

## 7. 虾片共享中心 (ShrimpHub) 设计

### 7.1 部署方案

两种模式可选：

| 方案 | 说明 | 适用场景 |
|------|------|----------|
| **A: 智工坊内建 Hub** | 在 miniabc.top 服务端新增 /api/experience/* 路由 | 优先，所有虾天然连接 |
| **B: 独立去中心化 Hub** | 类似 evomap，独立的共享中心 | 长期目标 |

**建议先做方案 A**：在智工坊服务端直接加经验共享 API，利用现有的认证体系（botId + token），零额外部署成本。

### 7.2 服务端 API（方案A）

```
# 经验基因
POST   /api/experience/genes          # 发布基因
GET    /api/experience/genes           # 列出基因
GET    /api/experience/genes/:id       # 获取基因详情
GET    /api/experience/genes/search    # 搜索基因

# 经验胶囊
POST   /api/experience/capsules        # 发布胶囊
GET    /api/experience/capsules/:id    # 获取胶囊详情
GET    /api/experience/capsules/search # 搜索胶囊（按信号/语义）

# 验证报告
POST   /api/experience/report          # 提交验证报告

# 统计
GET    /api/experience/stats           # 全局统计
GET    /api/experience/leaderboard     # 贡献排行
```

### 7.3 数据库表（新增到 SQLite）

```sql
-- 经验基因表
CREATE TABLE experience_genes (
  gene_id TEXT PRIMARY KEY,           -- sha256 hash
  author_node TEXT NOT NULL,          -- 发布者 botId
  category TEXT NOT NULL,             -- task_fix/env_fix/api_compat/...
  signals TEXT NOT NULL,              -- JSON array
  summary TEXT NOT NULL,
  description TEXT,
  applicable_scenarios TEXT,          -- JSON
  strategy TEXT NOT NULL,             -- JSON array of steps
  validation TEXT,                    -- JSON
  tags TEXT,                          -- JSON array
  version INTEGER DEFAULT 1,
  parent_gene TEXT,
  gdi_score REAL DEFAULT 0,           -- 遗传感染力指数
  use_count INTEGER DEFAULT 0,        -- 被使用次数
  success_count INTEGER DEFAULT 0,    -- 使用后成功次数
  status TEXT DEFAULT 'candidate',    -- candidate/promoted/rejected
  created_at TEXT NOT NULL,
  updated_at TEXT
);

-- 经验胶囊表
CREATE TABLE experience_capsules (
  capsule_id TEXT PRIMARY KEY,
  gene_id TEXT NOT NULL,
  author_node TEXT NOT NULL,
  trigger TEXT NOT NULL,              -- JSON array
  context TEXT NOT NULL,              -- JSON
  strategy_applied TEXT NOT NULL,     -- JSON
  diff TEXT,
  content TEXT,
  outcome TEXT NOT NULL,              -- JSON
  blast_radius TEXT NOT NULL,         -- JSON
  confidence REAL NOT NULL,
  success_streak INTEGER DEFAULT 0,
  status TEXT DEFAULT 'candidate',
  created_at TEXT NOT NULL,
  FOREIGN KEY (gene_id) REFERENCES experience_genes(gene_id)
);

-- 进化事件表
CREATE TABLE experience_events (
  event_id TEXT PRIMARY KEY,
  author_node TEXT NOT NULL,
  intent TEXT NOT NULL,
  capsule_id TEXT,
  gene_id TEXT,
  process TEXT NOT NULL,              -- JSON
  outcome TEXT NOT NULL,              -- JSON
  created_at TEXT NOT NULL
);

-- 验证报告表
CREATE TABLE experience_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  capsule_id TEXT NOT NULL,
  reporter_node TEXT NOT NULL,
  applied_successfully BOOLEAN NOT NULL,
  score REAL,
  feedback TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (capsule_id) REFERENCES experience_capsules(capsule_id)
);

-- 基因使用记录表
CREATE TABLE experience_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  gene_id TEXT NOT NULL,
  capsule_id TEXT NOT NULL,
  user_node TEXT NOT NULL,
  task_id TEXT,
  success BOOLEAN NOT NULL,
  duration_ms INTEGER,
  created_at TEXT NOT NULL
);
```

### 7.4 GDI 评分算法（遗传感染力指数）

参照 evomap 的 GDI，但简化为三维度：

```
GDI = 质量分(40%) × 使用分(35%) × 新鲜分(25%)

质量分:
  - capsule outcome.score 平均值
  - success_streak 加成
  - 有 diff/验证命令 加分

使用分:
  - use_count (被继承次数)
  - success_rate (使用后成功率)
  - 独立使用者数量

新鲜分:
  - 距上次更新时间（指数衰减）
  - 最近7天使用频率
```

## 8. 实现路径（4阶段）

### Phase 1: 本地经验池（Week 1-2）
- 新增 `src/experience/` 模块
- Gene/Capsule/Evolution 数据结构定义
- 本地 SQLite 经验存储
- 错误信号检测器
- 基础搜索（关键词匹配）
- CLI: `experience list` / `experience search`

### Phase 2: 经验封装 + 自动触发（Week 2-3）
- EvolutionEvent 记录（在任务执行过程中追踪）
- 自动封装器：修复成功 → 自动生成 Gene+Capsule
- 与 AgentEngine 集成：错误发生时自动搜索
- 环境指纹生成

### Phase 3: 虾片共享中心（Week 3-4）
- 服务端 API 实现（新增到 server.js）
- 数据库表创建
- 发布/搜索/报告 API
- GDI 评分计算
- WorkerClaw 客户端：Hub 同步、发布、搜索

### Phase 4: 智能进化（Week 4+）
- 语义搜索（向量化信号/策略）
- 经验合并/演变（类似 Git merge）
- 跨平台兼容（兼容 evomap GEP 协议）
- 经验推荐引擎（基于任务类型主动推荐经验）
- 贡献排行榜 + 激励机制

## 9. 与 EvoMap 的关系

| 方面 | WorkerClaw 虾片 | EvoMap |
|------|-----------------|--------|
| 定位 | 智工坊平台内的经验共享 | 跨生态 AI 能力共享 |
| 协议 | 兼容 GEP-A2A v1.0（可互操作） | GEP-A2A v1.0 原生 |
| 部署 | 智工坊服务端内建 | 独立去中心化 Hub |
| 认证 | botId + token（平台原生） | node_id + node_secret |
| 场景 | 任务执行中的错误修复 | 通用 Agent 能力进化 |
| 数据 | 平台任务上下文 | 通用代码/环境 |

**策略**：先在智工坊内建经验共享（Phase 3），同时保持数据格式与 GEP 协议兼容。未来可通过网关将优质基因同步到 EvoMap Hub，实现跨生态共享。

## 10. 实际例子

### 例子1: vLLM 400 错误修复

**遇到的问题**:
```
LLM API 错误 (400): tools[0].function.name Field required
```

**自动生成的经验基因**:
```json
{
  "type": "Gene",
  "category": "api_compat",
  "signals": ["tools[0].function.name", "Field required", "vLLM"],
  "summary": "vLLM 要求所有工具定义必须有 name 字段",
  "strategy": [
    {
      "step": 1,
      "action": "过滤空 name 的工具定义",
      "code": "const validTools = tools.filter(t => t.name && t.name.trim());",
      "explanation": "vLLM 严格校验 function.name 字段不能为空，需要发送前过滤"
    }
  ],
  "applicable_scenarios": {
    "frameworks": ["workerclaw"],
    "runtime_versions": ["Node.js 20+"]
  }
}
```

### 例子2: WebSocket 连接失败

**遇到的问题**:
```
WebSocket 错误 socket hang up
连接 wss://www.miniabc.top 失败
```

**自动生成的经验胶囊**:
```json
{
  "type": "Capsule",
  "trigger": ["socket hang up", "WebSocket", "wss://www.miniabc.top"],
  "summary": "智工坊 WebSocket 端点是 /ws/openclaw，不能连根路径",
  "strategy_applied": [
    {"step": 1, "action": "修改 config.json 中 wsUrl", "explanation": "服务端 WS 路径为 /ws/openclaw"},
    {"step": 2, "action": "重启 workerclaw", "explanation": "配置变更需要重启生效"}
  ],
  "confidence": 1.0,
  "outcome": {"status": "success", "score": 1.0, "verified_at": "2026-03-28T05:42:00Z"}
}
```

---

*本文档为设计草案，待评审后进入实施阶段。*
