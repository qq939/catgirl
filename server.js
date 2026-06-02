// ============================================
// 人兽替换 - 后端服务
// ============================================
// 环境变量（.env 文件自动加载，系统环境变量优先级更高）：
//   COZE_API_KEY=你的Coze个人访问令牌（必填）
//   PORT=8082（可选，默认8082）
// ============================================

require('dotenv').config();

const express = require('express');
const multer = require('multer');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const { ImageGenerationClient, Config } = require('coze-coding-dev-sdk');

const app = express();
const PORT = process.env.PORT || 8082;

// Coze API 配置
const COZE_API_KEY = process.env.COZE_API_KEY || '';

// OBS 上传配置
const OBS_BASE = 'http://obs.dimond.top';

// 初始化图片生成客户端
let imageClient = null;
if (COZE_API_KEY) {
  const config = new Config({
    apiKey: COZE_API_KEY,
    baseUrl: 'https://api.coze.cn',
  });
  imageClient = new ImageGenerationClient(config);
}

// 文件上传配置
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }
});

// 静态文件
app.use(express.static(path.join(__dirname)));
app.use(express.json());

// ===== 工具函数：上传文件到 OBS =====
function uploadToOBS(buffer, filename) {
  return new Promise((resolve, reject) => {
    const url = `${OBS_BASE}/${filename}`;
    const parsedUrl = new URL(url);

    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || 80,
      path: parsedUrl.pathname,
      method: 'PUT',
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Length': buffer.length,
      },
    };

    const req = http.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          // OBS 返回上传后的 URL
          const returnedUrl = body.trim() || url;
          resolve(returnedUrl);
        } else {
          reject(new Error(`OBS 上传失败: HTTP ${res.statusCode} ${body}`));
        }
      });
    });

    req.on('error', (err) => reject(new Error(`OBS 上传网络错误: ${err.message}`)));
    req.write(buffer);
    req.end();
  });
}

// ===== 工具函数：将 multer 文件上传到 OBS 并返回公开 URL =====
async function fileToPublicUrl(file, prefix = 'img') {
  const ext = path.extname(file.originalname) || '.jpg';
  const hash = crypto.randomBytes(8).toString('hex');
  const timestamp = Date.now();
  const filename = `hbs_${prefix}_${timestamp}_${hash}${ext}`;

  console.log(`[OBS] 上传 ${filename} (${(file.size / 1024).toFixed(1)}KB)`);
  const publicUrl = await uploadToOBS(file.buffer, filename);
  console.log(`[OBS] 上传成功: ${publicUrl}`);
  return publicUrl;
}

// ===== 健康检查 =====
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    configured: !!COZE_API_KEY,
    message: COZE_API_KEY ? '服务已就绪' : '请配置 COZE_API_KEY'
  });
});

// ===== 核心：单图生成 API =====
app.post('/api/generate', upload.single('image'), async (req, res) => {
  if (!imageClient) {
    return res.status(500).json({ error: '未配置 COZE_API_KEY，请在 .env 文件或环境变量中设置' });
  }

  const direction = req.body.direction;
  const imageFile = req.file;

  if (!direction || !imageFile) {
    return res.status(400).json({ error: '缺少 direction 或 image 参数' });
  }

  try {
    const prompt = buildSinglePrompt(direction);

    // 先上传图片到 OBS 获取公开 URL
    const imageUrl = await fileToPublicUrl(imageFile, 'single');

    console.log(`[生成] direction=${direction}, 图片大小=${(imageFile.size/1024).toFixed(1)}KB`);

    const response = await imageClient.generate({
      prompt: prompt,
      image: imageUrl,
      size: '2K',
    });

    const helper = imageClient.getResponseHelper(response);
    if (!helper.success || !helper.imageUrls || helper.imageUrls.length === 0) {
      throw new Error('图片生成未返回有效结果');
    }

    const resultUrl = helper.imageUrls[0];
    console.log(`[生成成功] URL: ${resultUrl}`);
    res.json({ success: true, imageUrl: resultUrl });

  } catch (err) {
    console.error('生成失败:', err);
    res.status(500).json({ error: `生成失败: ${err.message}` });
  }
});

// ===== 双图模式：上传猫咪+人物两张参考图 =====
app.post('/api/generate-dual', upload.fields([
  { name: 'catImage', maxCount: 1 },
  { name: 'humanImage', maxCount: 1 }
]), async (req, res) => {
  if (!imageClient) {
    return res.status(500).json({ error: '未配置 COZE_API_KEY' });
  }

  const direction = req.body.direction;
  const catFile = req.files?.catImage?.[0];
  const humanFile = req.files?.humanImage?.[0];

  if (!direction || !catFile || !humanFile) {
    return res.status(400).json({ error: '缺少 direction、catImage 或 humanImage' });
  }

  try {
    const prompt = buildDualPrompt(direction);

    // 双图模式：参考图为目标方向的源图，上传到 OBS 获取 URL
    const refFile = direction === 'generate-cat' ? humanFile : catFile;
    const refUrl = await fileToPublicUrl(refFile, 'dual');

    console.log(`[双图生成] direction=${direction}`);

    const response = await imageClient.generate({
      prompt: prompt,
      image: refUrl,
      size: '2K',
    });

    const helper = imageClient.getResponseHelper(response);
    if (!helper.success || !helper.imageUrls || helper.imageUrls.length === 0) {
      throw new Error('图片生成未返回有效结果');
    }

    const resultUrl = helper.imageUrls[0];
    console.log(`[双图生成成功] URL: ${resultUrl}`);
    res.json({ success: true, imageUrl: resultUrl, direction });

  } catch (err) {
    console.error('双图生成失败:', err);
    res.status(500).json({ error: `生成失败: ${err.message}` });
  }
});

// ===== Prompt 构建 =====
function buildSinglePrompt(direction) {
  if (direction === 'cat-to-human') {
    return `将参考图中的猫咪1:1替换为病娇小少妇，严格还原猫咪的姿势动作和神情。猫咪歪头半眯眼→她头微微歪向一侧，眼皮半耷拉半眯，眼神慵懒空洞又带一丝满足；猫咪嘴里含吸管喝冰美式→她嘴唇含白色吸管，吸管插在透明塑料杯的深褐色冰美式里，杯中冰块清晰；猫咪前爪搭桌上→她的手随意搭在浅棕色木纹桌面上；猫咪脖子挂工牌→她脖子挂工牌绳，工牌证件照是穿正装的二次元萝莉动漫角色大头照（蓝底标准证件照排版）。25岁少妇，苍白皮肤，黑微卷长发，病娇气质，白衬衫微敞，黑包臀裙，桌上键盘旁立萝莉手办，领口别萝莉胸针。灰色工位背景虚化。写实摄影电影画质伦勃朗光3:4竖构图。`;
  } else {
    return `将参考图中的人物1:1替换为一只猫，严格还原人物的姿势动作和神情。人物歪头半眯眼→猫咪歪头半眯眼慵懒空洞；人物含吸管喝冰美式→猫咪嘴里含白色吸管，吸管插在透明塑料杯冰美式里，杯中冰块清晰；人物手搭桌上→猫咪前爪搭浅棕色木纹桌面；人物脖子挂工牌→猫咪脖子挂工牌绳，工牌证件照是猫咪穿正装照片。胖橘白相间猫咪，粉鼻头，白色胡须，慵懒满足。灰色工位背景虚化。写实摄影电影画质3:4竖构图。`;
  }
}

function buildDualPrompt(direction) {
  if (direction === 'generate-human') {
    return `参考图1是一只猫咪，参考图2是一个人物。以图1的猫咪为原型，将猫咪1:1替换为人物，严格还原猫咪的姿势动作和神情到人物身上。参考图2的人物外貌特征作为生成人物的参考，但姿势神情必须严格对应图1的猫咪。猫咪歪头半眯眼→人物歪头半眯眼；猫咪含吸管→人物含吸管；猫咪前爪搭桌→人物手搭桌；猫咪挂工牌→人物挂工牌，工牌证件照是穿正装的二次元萝莉角色。灰色工位背景虚化。写实摄影电影画质伦勃朗光3:4竖构图。`;
  } else {
    return `参考图1是一只猫咪，参考图2是一个人物。以图2的人物为原型，将人物1:1替换为猫咪，严格还原人物的姿势动作和神情到猫咪身上。参考图1的猫咪外貌特征（毛色、体型）作为生成猫咪的参考，但姿势神情必须严格对应图2的人物。人物歪头半眯眼→猫咪歪头半眯眼；人物含吸管→猫咪含吸管；人物手搭桌→猫咪前爪搭桌；人物挂工牌→猫咪挂工牌，工牌证件照是猫咪穿正装。灰色工位背景虚化。写实摄影电影画质3:4竖构图。`;
  }
}

// ===== 启动 =====
app.listen(PORT, () => {
  console.log(`\n🐾 人兽替换服务已启动`);
  console.log(`   地址: http://localhost:${PORT}`);
  console.log(`   API Key: ${COZE_API_KEY ? '✅ 已配置' : '❌ 未配置'}`);
  console.log(`   OBS 中转: ✅ 已启用 (${OBS_BASE})`);
  if (!COZE_API_KEY) {
    console.log(`\n   请配置 COZE_API_KEY：`);
    console.log(`   方法1: 复制 .env.example 为 .env，填入 COZE_API_KEY=xxx`);
    console.log(`   方法2: export COZE_API_KEY="你的API Key"`);
  }
  console.log();
});
