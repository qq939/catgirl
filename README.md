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

### 2. 配置环境变量

复制 `.env.example` 为 `.env`，填入配置：

```bash
cp .env.example .env
```

必填项：
- `COZE_API_KEY`：Coze 个人访问令牌（[获取地址](https://www.coze.cn/open/oauth/pats)）
- `COZE_WORKFLOW_ID`：Coze 工作流 ID（详见下方配置指南）

### 3. 创建 Coze 工作流

这是最关键的一步！详见 [SETUP_GUIDE.md](./SETUP_GUIDE.md)

简要步骤：
1. 在 [coze.cn](https://www.coze.cn) 创建工作流
2. 添加"图像生成"节点，提示词设为 `{{prompt}}`，参考图设为 `{{image_url}}`
3. 试运行成功后发布
4. 从浏览器地址栏获取 workflow_id

### 4. 启动服务

```bash
npm start
```

访问 http://localhost:8082

## 环境变量

| 变量 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| COZE_API_KEY | 是 | - | Coze 个人访问令牌（PAT） |
| COZE_WORKFLOW_ID | 是 | - | Coze 工作流 ID |
| PORT | 否 | 8082 | 服务端口 |

系统环境变量优先级高于 `.env` 文件。

## 项目结构

```
human-beast-swap/
├── server.js           # 后端服务（Express + Coze Workflow API）
├── index.html          # 前端页面
├── images/             # 本地示例图
│   ├── demo-cat.jpg    # 猫咪示例
│   └── demo-human.jpg  # 人物示例
├── package.json        # 依赖配置
├── .env.example        # 环境变量模板
├── .env                # 环境变量（不纳入版本控制）
├── SETUP_GUIDE.md      # 详细配置指南
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

## 图片生成流程

```
用户上传图片 → OBS中转获取公开URL → 调用Coze Workflow API → 返回生成图片URL
```

1. 用户上传的图片先传到 OBS 中转服务，获取公开可访问的 URL
2. 将 prompt + image_url 传给 Coze 工作流
3. 工作流中的图像生成节点基于 prompt 和参考图生成新图
4. 返回生成图片的 URL

## 技术栈

- 后端：Express + multer + dotenv
- 前端：原生 HTML/CSS/JS
- AI：Coze Workflow API + Seedream 图像生成模型
