# 🐾 人兽替换（Human-Beast-Swap）

AI 驱动的猫咪↔人物图片替换网站。上传猫咪或人物照片，AI 自动生成对应的替换形象。

## 功能

- **单图模式**：上传一张猫咪或人物图片，自动生成对应的替换形象
- **双图模式**：同时上传猫咪和人物参考图，选择生成方向，AI 基于两张参考图生成结果

## 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 配置 API Key

复制 `.env.example` 为 `.env`，填入你的 Coze API Key：

```bash
cp .env.example .env
# 编辑 .env，设置 COZE_API_KEY
```

或通过系统环境变量设置（优先级更高）：

```bash
export COZE_API_KEY="你的API Key"
```

### 3. 启动服务

```bash
npm start
# 或指定端口
PORT=8082 node server.js
```

访问 http://localhost:8082

## 环境变量

| 变量 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| COZE_API_KEY | 是 | - | Coze 个人访问令牌 |
| PORT | 否 | 8082 | 服务端口 |

系统环境变量优先级高于 `.env` 文件。

## 项目结构

```
human-beast-swap/
├── server.js           # 后端服务（Express + Coze SDK）
├── index.html          # 前端页面
├── images/             # 本地示例图
│   ├── demo-cat.jpg    # 猫咪示例
│   └── demo-human.jpg  # 人物示例
├── package.json        # 依赖配置
├── .env.example        # 环境变量模板
├── .env                # 环境变量（不纳入版本控制）
├── WORKFLOW_DESIGN.md  # Coze 工作流设计文档
└── README.md           # 本文件
```

## API 接口

### 单图生成

```
POST /api/generate
Content-Type: multipart/form-data

参数：
- image: 图片文件
- direction: "cat-to-human" | "human-to-cat"
```

### 双图生成

```
POST /api/generate-dual
Content-Type: multipart/form-data

参数：
- catImage: 猫咪参考图文件
- humanImage: 人物参考图文件
- direction: "generate-human" | "generate-cat"
```

### 健康检查

```
GET /api/health
```

## Coze 工作流

详见 [WORKFLOW_DESIGN.md](./WORKFLOW_DESIGN.md)，包含单图模式和双图模式的完整工作流设计。
可在 Coze 平台可视化搭建，也可继续使用当前 SDK 模式。

## 技术栈

- 后端：Express + multer + dotenv + coze-coding-dev-sdk
- 前端：原生 HTML/CSS/JS
- AI：Coze 图片生成 API（支持参考图生成）
