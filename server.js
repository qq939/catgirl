// ============================================
// 人兽替换 - 后端服务（Coze Workflow API 模式）
// ============================================
// 通过 Coze Workflow API 调用图片生成，无需 CLI
// 环境变量（.env 文件自动加载，系统环境变量优先级更高）：
//   COZE_API_KEY=pat_xxx（必填，Coze PAT 令牌）
//   COZE_WORKFLOW_ID=xxx（必填，Coze 工作流 ID）
//   PORT=8082（可选，默认8082）
// ============================================

require('dotenv').config();

const express = require('express');
const multer = require('multer');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const http = require('http');

const app = express();
const PORT = process.env.PORT || 8082;

// Coze API 配置
const COZE_API_KEY = process.env.COZE_API_KEY;
const COZE_WORKFLOW_ID = process.env.COZE_WORKFLOW_ID || '7646775083549687862';
const COZE_API_BASE = 'https://api.coze.cn';

// OBS 上传配置（备用，用于生成公开 URL）
const OBS_BASE = 'http://obs.dimond.top';

// 文件上传配置
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }
});

// 静态文件
app.use(express.static(path.join(__dirname)));
app.use(express.json());

// ===== 检查配置 =====
function checkConfig() {
  const missing = [];
  if (!COZE_API_KEY) missing.push('COZE_API_KEY');
  if (!COZE_WORKFLOW_ID) missing.push('COZE_WORKFLOW_ID');
  if (missing.length > 0) {
    console.error(`\n❌ 缺少必填环境变量: ${missing.join(', ')}`);
    console.error('   请在 .env 文件中配置，参考 .env.example\n');
  }
  return missing.length === 0;
}

// ===== 工具函数：从 buffer 解析图片尺寸（支持 JPEG/PNG/WebP） =====
function getImageSize(buffer) {
  // PNG: 宽高在 IHDR chunk（偏移16-23）
  if (buffer[0] === 0x89 && buffer[1] === 0x50) { // \x89PNG
    return {
      width: buffer.readUInt32BE(16),
      height: buffer.readUInt32BE(20),
    };
  }
  // JPEG: 查找 SOF0/SOF2 标记 (0xFFC0 / 0xFFC2)
  if (buffer[0] === 0xFF && buffer[1] === 0xD8) {
    let offset = 2;
    while (offset < buffer.length - 1) {
      if (buffer[offset] !== 0xFF) break;
      const marker = buffer[offset + 1];
      // SOF0, SOF1, SOF2 等标记
      if (marker === 0xC0 || marker === 0xC1 || marker === 0xC2) {
        return {
          height: buffer.readUInt16BE(offset + 5),
          width: buffer.readUInt16BE(offset + 7),
        };
      }
      // 跳过非SOF标记段
      const segLen = buffer.readUInt16BE(offset + 2);
      offset += 2 + segLen;
    }
  }
  // WebP: 简单解析
  if (buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50) {
    // VP8 lossy
    if (buffer[12] === 0x56 && buffer[13] === 0x50 && buffer[14] === 0x38 && buffer[15] === 0x20) {
      const w = (buffer.readUInt16BE(26) & 0x3FFF);
      const h = (buffer.readUInt16BE(28) & 0x3FFF);
      return { width: w, height: h };
    }
    // VP8L lossless
    if (buffer[12] === 0x56 && buffer[13] === 0x50 && buffer[14] === 0x38 && buffer[15] === 0x4C) {
      const bits = buffer.readUInt32LE(21);
      return { width: (bits & 0x3FFF) + 1, height: ((bits >> 14) & 0x3FFF) + 1 };
    }
  }
  return null;
}

// ===== 工具函数：计算宽高比描述（用于提示词） =====
function getAspectRatioDesc(buffer) {
  const size = getImageSize(buffer);
  if (!size) return '';
  const { width, height } = size;
  // 计算最简比
  const g = gcd(width, height);
  const rw = width / g;
  const rh = height / g;
  // 如果比值太大，用近似常用比
  const ratio = width / height;
  const commonRatios = [[1,1],[4,3],[3,4],[3,2],[2,3],[16,9],[9,16],[16,10],[10,16],[21,9],[9,21],[2,1],[1,2]];
  for (const [a, b] of commonRatios) {
    if (Math.abs(ratio - a/b) < 0.05) {
      return `${a}:${b}`;
    }
  }
  // 原始最简比
  if (rw <= 30 && rh <= 30) return `${rw}:${rh}`;
  // 大数近似
  if (ratio > 1) return `约${Math.round(ratio*10)/10}:1`;
  return `约1:${Math.round((1/ratio)*10)/10}`;
}

function gcd(a, b) { return b === 0 ? a : gcd(b, a % b); }

// ===== 工具函数：通用 HTTP 请求 =====
function httpRequest(url, options, body) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const isHttps = parsedUrl.protocol === 'https:';
    const lib = isHttps ? https : http;

    const reqOptions = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (isHttps ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      method: options.method || 'GET',
      headers: options.headers || {},
      timeout: options.timeout || 120000, // 默认2分钟超时
    };

    const req = lib.request(reqOptions, (res) => {
      const chunks = [];
      res.on('data', (chunk) => { chunks.push(chunk); });
      res.on('end', () => {
        const rawData = Buffer.concat(chunks);
        const body = options.binary ? rawData : rawData.toString('utf8');
        resolve({ statusCode: res.statusCode, headers: res.headers, body });
      });
    });

    req.on('error', (err) => reject(err));
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });

    if (body) {
      if (Buffer.isBuffer(body)) {
        req.write(body);
      } else {
        req.write(body);
      }
    }
    req.end();
  });
}

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

// ===== 工具函数：上传文件到 Coze 文件服务 =====
async function uploadToCoze(fileBuffer, filename) {
  const boundary = '----FormBoundary' + crypto.randomBytes(16).toString('hex');

  // 构建 multipart/form-data
  const header = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`;
  const footer = `\r\n--${boundary}--\r\n`;

  const body = Buffer.concat([
    Buffer.from(header, 'utf8'),
    fileBuffer,
    Buffer.from(footer, 'utf8'),
  ]);

  const url = `${COZE_API_BASE}/v1/files/upload`;
  const response = await httpRequest(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${COZE_API_KEY}`,
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'Content-Length': body.length,
    },
  }, body);

  const result = JSON.parse(response.body);
  if (result.code !== 0) {
    throw new Error(`Coze 文件上传失败: ${result.msg}`);
  }

  const fileId = result.data.id;
  console.log(`[Coze] 文件上传成功: file_id=${fileId}`);
  return fileId;
}

// ===== 工具函数：调用 Coze Workflow API 生成图片 =====
async function cozeWorkflowRun(prompt, imageUrl) {
  if (!COZE_API_KEY || !COZE_WORKFLOW_ID) {
    throw new Error('请配置 COZE_API_KEY 和 COZE_WORKFLOW_ID 环境变量');
  }

  // 构建工作流参数
  const parameters = {
    prompt: prompt,
  };

  // 如果有参考图片，添加 image 参数
  if (imageUrl) {
    // 工作流支持两种图片输入方式：
    // 1. 直接传 URL 字符串（如果工作流的 image 参数是文本类型）
    // 2. 传 {"file_id": "xxx"} 格式（如果工作流的 image 参数是文件类型）
    // 这里同时传两种格式，工作流端根据配置选择使用哪个
    parameters.image_url = imageUrl;
  }

  const url = `${COZE_API_BASE}/v1/workflow/run`;
  const requestBody = JSON.stringify({
    workflow_id: COZE_WORKFLOW_ID,
    parameters: parameters,
  });

  console.log(`[Workflow] 调用工作流: ${COZE_WORKFLOW_ID}`);
  console.log(`[Workflow] 参数: prompt=${prompt.substring(0, 50)}...${imageUrl ? ', image_url=' + imageUrl.substring(0, 60) + '...' : ''}`);

  const response = await httpRequest(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${COZE_API_KEY}`,
      'Content-Type': 'application/json',
    },
  }, requestBody);

  const result = JSON.parse(response.body);

  if (result.code !== 0) {
    throw new Error(`工作流执行失败: ${result.msg}`);
  }

  // 解析工作流输出 - Coze 返回的 data 是字符串化的 JSON
  let outputData;
  try {
    outputData = JSON.parse(result.data);
  } catch (e) {
    // 如果 data 本身就是 URL
    if (typeof result.data === 'string' && result.data.startsWith('http')) {
      return result.data;
    }
    throw new Error(`工作流输出解析失败: ${e.message}, raw: ${result.data?.substring(0, 200)}`);
  }

  // 尝试多种输出格式
  // 格式1: { data: "https://..." }
  if (outputData.data) {
    if (typeof outputData.data === 'string' && outputData.data.startsWith('http')) {
      return outputData.data;
    }
    // 格式2: { data: { output: "https://..." } }
    if (typeof outputData.data === 'object' && outputData.data.output) {
      const output = outputData.data.output;
      if (typeof output === 'string' && output.startsWith('http')) {
        return output;
      }
      // 格式3: output 是数组
      if (Array.isArray(output) && output.length > 0) {
        const firstItem = output[0];
        if (typeof firstItem === 'string' && firstItem.startsWith('http')) {
          return firstItem;
        }
        if (firstItem?.url) {
          return firstItem.url;
        }
        if (firstItem?.image_url) {
          return firstItem.image_url;
        }
      }
    }
  }

  // 格式4: { output: "https://..." }
  if (outputData.output) {
    if (typeof outputData.output === 'string' && outputData.output.startsWith('http')) {
      return outputData.output;
    }
    if (Array.isArray(outputData.output) && outputData.output.length > 0) {
      const firstItem = outputData.output[0];
      if (typeof firstItem === 'string' && firstItem.startsWith('http')) {
        return firstItem;
      }
      if (firstItem?.url) return firstItem.url;
      if (firstItem?.image_url) return firstItem.image_url;
    }
  }

  // 格式5: 直接是 URL
  if (typeof outputData === 'string' && outputData.startsWith('http')) {
    return outputData;
  }

  console.error('[Workflow] 无法解析输出:', JSON.stringify(outputData).substring(0, 500));
  throw new Error('工作流未返回有效图片 URL，请检查工作流配置');
}

// ===== 工具函数：下载图片并上传到 OBS =====
async function downloadAndUploadToOBS(imageUrl, prefix = 'result') {
  console.log(`[OBS] 下载生成图: ${imageUrl.substring(0, 80)}...`);
  
  // 下载图片（二进制模式）
  const response = await httpRequest(imageUrl, { method: 'GET', timeout: 60000, binary: true });
  if (response.statusCode !== 200) {
    throw new Error(`下载生成图失败: HTTP ${response.statusCode}`);
  }
  
  const buffer = response.body;
  
  // 根据内容判断扩展名
  let ext = '.png';
  if (buffer[0] === 0xFF && buffer[1] === 0xD8) ext = '.jpg';
  else if (buffer[0] === 0x89 && buffer[1] === 0x50) ext = '.png';
  else if (buffer[8] === 0x57 && buffer[9] === 0x45) ext = '.webp';
  
  // 时间戳文件名
  const now = new Date();
  const ts = `${now.getFullYear()}${String(now.getMonth()+1).padStart(2,'0')}${String(now.getDate()).padStart(2,'0')}_${String(now.getHours()).padStart(2,'0')}${String(now.getMinutes()).padStart(2,'0')}${String(now.getSeconds()).padStart(2,'0')}`;
  const hash = crypto.randomBytes(4).toString('hex');
  const filename = `hbs_${prefix}_${ts}_${hash}${ext}`;
  
  console.log(`[OBS] 上传生成图 ${filename} (${(buffer.length / 1024).toFixed(1)}KB)`);
  const publicUrl = await uploadToOBS(buffer, filename);
  console.log(`[OBS] 生成图已保存: ${publicUrl}`);
  return publicUrl;
}

// ===== 健康检查 =====
app.get('/api/health', (req, res) => {
  const configOk = checkConfig();
  res.json({
    status: configOk ? 'ok' : 'config_missing',
    mode: 'workflow-api',
    coze_api_key: COZE_API_KEY ? '✅ 已配置' : '❌ 未配置',
    coze_workflow_id: COZE_WORKFLOW_ID ? '✅ 已配置' : '❌ 未配置',
    message: configOk ? '服务已就绪（Coze Workflow API 模式）' : '请配置 COZE_API_KEY 和 COZE_WORKFLOW_ID',
  });
});

// ===== 核心：单图生成 API =====
app.post('/api/generate', upload.single('image'), async (req, res) => {
  const direction = req.body.direction;
  const imageFile = req.file;

  if (!direction || !imageFile) {
    return res.status(400).json({ error: '缺少 direction 或 image 参数' });
  }

  if (!COZE_API_KEY || !COZE_WORKFLOW_ID) {
    return res.status(500).json({ error: '请配置 COZE_API_KEY 和 COZE_WORKFLOW_ID 环境变量' });
  }

  try {
    const prompt = buildSinglePrompt(direction, imageFile.buffer);

    // 上传图片到 OBS 获取公开 URL（工作流需要可访问的图片 URL）
    const imageUrl = await fileToPublicUrl(imageFile, 'single');

    console.log(`[生成] direction=${direction}, 图片大小=${(imageFile.size/1024).toFixed(1)}KB`);

    // 调用 Coze Workflow API 生成图片
    const resultUrl = await cozeWorkflowRun(prompt, imageUrl);

    // 将生成图下载并上传到 OBS（带时间戳文件名）
    const obsUrl = await downloadAndUploadToOBS(resultUrl, 'single');

    console.log(`[生成成功] OBS: ${obsUrl}`);
    res.json({ success: true, imageUrl: obsUrl });

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
  const direction = req.body.direction;
  const catFile = req.files?.catImage?.[0];
  const humanFile = req.files?.humanImage?.[0];

  if (!direction || !catFile || !humanFile) {
    return res.status(400).json({ error: '缺少 direction、catImage 或 humanImage' });
  }

  if (!COZE_API_KEY || !COZE_WORKFLOW_ID) {
    return res.status(500).json({ error: '请配置 COZE_API_KEY 和 COZE_WORKFLOW_ID 环境变量' });
  }

  try {
    // 双图模式：参考图为目标方向的源图
    const refFile = direction === 'generate-cat' ? humanFile : catFile;
    const prompt = buildDualPrompt(direction, refFile.buffer);
    const refUrl = await fileToPublicUrl(refFile, 'dual');

    console.log(`[双图生成] direction=${direction}`);

    // 调用 Coze Workflow API 生成图片
    const resultUrl = await cozeWorkflowRun(prompt, refUrl);

    // 将生成图下载并上传到 OBS（带时间戳文件名）
    const obsUrl = await downloadAndUploadToOBS(resultUrl, 'dual');

    console.log(`[双图生成成功] OBS: ${obsUrl}`);
    res.json({ success: true, imageUrl: obsUrl, direction });

  } catch (err) {
    console.error('双图生成失败:', err);
    res.status(500).json({ error: `生成失败: ${err.message}` });
  }
});

// ===== 自定义提示词（持久化到 prompts.json） =====
const fs = require('fs');
const PROMPTS_FILE = path.join(__dirname, 'prompts.json');

const DEFAULT_PROMPTS = {
  'cat-to-human': `将参考图中的动物1:1替换为病娇萝莉少女，严格还原动物的神态、动作、构图、场景及所有细节，每一个姿态和表情都对应映射到人物身上。16岁病娇萝莉，苍白皮肤，黑色长直发齐刘海，眼神慵懒空洞又带一丝满足，身穿白色水手服上衣搭配深蓝百褶短裙，领口系红色蝴蝶结，过膝白色长袜，脚踩黑色玛丽珍鞋，颈戴蕾丝choker，身边散落洛丽塔发饰和丝带。写实摄影电影画质伦勃朗光。`,
  'human-to-cat': `将参考图中的人物1:1替换为一只猫，严格还原人物的神态、动作、构图、场景及所有细节，每一个姿态和表情都对应映射到猫咪身上。胖橘白相间猫咪，圆脸大眼，粉鼻头，白色胡须，毛色橘白交替，慵懒满足的神态，粉嫩肉垫。写实摄影电影画质。`
};

function loadPrompts() {
  try {
    if (fs.existsSync(PROMPTS_FILE)) {
      const saved = JSON.parse(fs.readFileSync(PROMPTS_FILE, 'utf8'));
      return { ...DEFAULT_PROMPTS, ...saved };
    }
  } catch (e) {
    console.error('[Prompts] 读取失败，使用默认值:', e.message);
  }
  return { ...DEFAULT_PROMPTS };
}

function savePrompts(prompts) {
  fs.writeFileSync(PROMPTS_FILE, JSON.stringify(prompts, null, 2), 'utf8');
}

let customPrompts = loadPrompts();

// ===== 提示词 API =====
app.get('/api/prompts', (req, res) => {
  res.json(customPrompts);
});

app.post('/api/prompts', express.json(), (req, res) => {
  const { 'cat-to-human': c2h, 'human-to-cat': h2c } = req.body;
  if (c2h !== undefined) customPrompts['cat-to-human'] = c2h;
  if (h2c !== undefined) customPrompts['human-to-cat'] = h2c;
  savePrompts(customPrompts);
  res.json({ success: true, prompts: customPrompts });
});

// ===== Prompt 构建 =====
function buildSinglePrompt(direction, imageBuffer) {
  let basePrompt;
  if (direction === 'cat-to-human') {
    basePrompt = customPrompts['cat-to-human'];
  } else {
    basePrompt = customPrompts['human-to-cat'];
  }
  // 追加原始图片宽高比
  const aspectDesc = imageBuffer ? getAspectRatioDesc(imageBuffer) : '';
  if (aspectDesc) {
    return `${basePrompt} 保持原始图片宽高比${aspectDesc}。`;
  }
  return basePrompt;
}

function buildDualPrompt(direction, imageBuffer) {
  let basePrompt;
  if (direction === 'generate-human') {
    basePrompt = customPrompts['cat-to-human'];
  } else {
    basePrompt = customPrompts['human-to-cat'];
  }
  const aspectDesc = imageBuffer ? getAspectRatioDesc(imageBuffer) : '';
  if (aspectDesc) {
    return `${basePrompt} 保持原始图片宽高比${aspectDesc}。`;
  }
  return basePrompt;
}

// ===== 启动 =====
app.listen(PORT, () => {
  const configOk = checkConfig();
  console.log(`\n🐾 人兽替换服务已启动（Workflow API 模式）`);
  console.log(`   地址: http://localhost:${PORT}`);
  console.log(`   模式: Coze Workflow API`);
  console.log(`   API Key: ${COZE_API_KEY ? '✅ 已配置' : '❌ 未配置'}`);
  console.log(`   Workflow ID: ${COZE_WORKFLOW_ID || '❌ 未配置'}`);
  console.log(`   OBS 中转: ✅ 已启用 (${OBS_BASE})`);
  if (!configOk) {
    console.log(`\n   ⚠️  请在 .env 中配置 COZE_API_KEY 和 COZE_WORKFLOW_ID`);
    console.log(`   参考 SETUP_GUIDE.md 获取详细配置说明\n`);
  }
  console.log();
});
