# qoder-cf-gw

Qoder 国际版转 OpenAI / Anthropic 兼容 API 的 Cloudflare Worker 网关，带账号池管理与**每日自动签到领 100 Credits**。纯 Workers 运行时（KV + Durable Objects），无服务器依赖，部署即用。

## 功能特性

- **三协议兼容**：OpenAI Chat Completions（`/v1/chat/completions`）、OpenAI Responses（`/v1/responses`）、Anthropic Messages（`/v1/messages` + `count_tokens`），主流客户端/SDK 直连
- **账号池**：多 Qoder 账号轮询，token 自动续期（单飞锁防并发刷新作废），账号级用量统计
- **API Key 管理**：多把 Key、独立调用计数、每日限额，管理后台可视化
- **每日签到**：cron 三轮自动签到领 Credits，回执与到账落库可查（详见下文）
- **模型映射/假名**：请求模型名 → 上游模型自由映射，支持别名
- **管理后台**：`/admin` 单页（登录密码保护），账号/Key/签到/统计一站式

## API 一览

### LLM 兼容端点（`X-API-Key: <key>` 认证）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/v1/models`、`/v1/models/{id}` | 模型列表/详情 |
| POST | `/v1/chat/completions` | OpenAI Chat 协议（流式/非流式） |
| POST | `/v1/responses` | OpenAI Responses 协议 |
| POST | `/v1/messages` | Anthropic Messages 协议（流式/非流式） |
| POST | `/v1/messages/count_tokens` | token 估算 |
| GET | `/health`、`/` | 健康检查 |

### 管理 API（`Authorization: Bearer <ADMIN_PASSWORD>` 认证）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET/POST | `/api/accounts`、`/api/accounts/import` | 账号列表 / 批量导入 |
| PATCH/DELETE | `/api/accounts/:id` | 更新（token、machine_id、machine_hostname、cosy_version 等白名单字段）/ 删除 |
| POST | `/api/accounts/:id/test`、`/refresh`、`/checkin` | 可用性测试 / 手动续期 / **手动签到** |
| GET | `/api/accounts/:id/campaigns` | 查上游活动列表（签到排查用） |
| GET/POST/PATCH/DELETE | `/api/keys`（含 `:id/reset`） | API Key 全生命周期 |
| GET | `/api/models`、`/api/model-routes`、`/api/stats` | 上游模型 / 模型映射 / 用量统计 |

## 每日签到机制

对齐 Qoder 桌面客户端（App 0.4.8）真实请求形态（逆向报告见姊妹仓库 `llm-proxy/`）：

- **账号池身份**：每号独立 `machine_id` / `machine_token` / `machine_hostname`（缺失时确定性生成），`Cosy-ClientType: 10`
- **请求形态**：`Cosy-Version: 0.4.8` + `Cosy-MachineHostname`；活动列表 GET 用 `User-Agent: Qoder`，claim POST 用 Electron UA；`Cosy-*` 头值过可打印 ASCII 校验，非法整头丢弃
- **领取策略**：只领列表里 `actionType=CLAIM_BENEFIT` 且 `claimStatus=CLAIMABLE` 的条目，循环逐个 POST claim；无可领条目 = 成功 no-op
- **cron 三轮兜底**：每天北京时间 **11:00 / 12:00 / 13:00**（UTC 03/04/05 整点）各跑一轮，前一轮没领到自动重试，已到账自动跳过（claim 幂等，重复无害）
- **签到窗口**：上游每日活动约 10:00（北京时间）后开放，11 点首轮已在窗口内

## 架构

```
wrangler.toml ── Workers 部署配置（cron / KV / DO 绑定）
src/index.js ── 入口：路由 + LLM 协议分发 + scheduled(签到 cron)
src/qoder/client.js ── 上游客户端：登录/续期/对话转发/签到（设备头形态）
src/qoder/cosy.js ── COSY 请求签名（对话链路）
src/chat.js / convert.js ── 协议转换（OpenAI ↔ Anthropic ↔ Responses）
src/store.js / accounts.js / tokens.js / models.js / model-routes.js
src/admin.js ── 管理后台单页
src/refresh-lock.js / usage-counter.js / key-counter.js ── 三个 Durable Objects
```

| 组件 | 用途 |
|---|---|
| KV | 账号池、API Key、签到记录、模型映射（免费额度 10 万读/千写每天） |
| RefreshLock (DO) | 单飞续期锁：refresh_token 一次性轮换，防多 isolate 并发刷新互相作废 |
| UsageCounter (DO) | 每日用量计数（每 UTC 日期一个实例） |
| KeyCounter (DO) | API Key 调用次数原子计数（每 key 一个实例） |

## 部署

```bash
# 1) 配置凭据（环境变量，勿写进任何文件）
export CLOUDFLARE_API_TOKEN=<your-token>
export CLOUDFLARE_ACCOUNT_ID=<your-account-id>

# 2) 注入管理密码（secret，不进仓库）
npx wrangler secret put ADMIN_PASSWORD

# 3) 部署（首次会自动创建 KV/DO 绑定见 wrangler.toml）
npx wrangler deploy
```

部署后 `https://<worker>.workers.dev` 即可用；绑定自定义域名照常走 Cloudflare。

## 本地开发与测试

```bash
npm test    # node --test 六套测试（core/routes/accounts/keys/device/cosy），全离线 mock
npm run check  # 语法检查全部 src 文件
```

测试不触网（mock 上游 + 内存 KV），`test/e2e.local.mjs` 是可选的真实账号本地 E2E（需自备账号文件）。

## 相关项目

- **llm-proxy**（姊妹仓库）：本地 Python 版（国际版 `qoder_intl_proxy.py` + 国内版 `qoder_proxy.py`），含三份客户端逆向报告：
  - `reverse_asar_findings.md` — 桌面客户端 app.asar 逆向（签到请求形态规格）
  - `reverse_worker_findings.md` — worker runtime 逆向
  - `reverse_h5_campaign_findings.md` — 签到 H5 页面逆向（list/claim/reward 端点与状态机）