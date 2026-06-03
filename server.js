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

// ===== 工具函数：计算生成图尺寸（短边1080，长边按比例，范围1080-4320） =====
function calculateTargetSize(buffer) {
  const size = getImageSize(buffer);
  if (!size) return null;
  let { width, height } = size;
  
  // 短边设为1080，长边按比例
  if (width <= height) {
    // 竖版：宽是短边
    const targetW = 1080;
    const targetH = Math.round(1080 * height / width);
    return { width: targetW, height: Math.min(targetH, 4320) };
  } else {
    // 横版：高是短边
    const targetH = 1080;
    const targetW = Math.round(1080 * width / height);
    return { width: Math.min(targetW, 4320), height: targetH };
  }
}

// ===== 工具函数：从 buffer 解析图片尺寸（支持 JPEG/PNG/WebP） =====
function getImageSize(buffer) {
  // PNG
  if (buffer[0] === 0x89 && buffer[1] === 0x50) {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  // JPEG
  if (buffer[0] === 0xFF && buffer[1] === 0xD8) {
    let offset = 2;
    while (offset < buffer.length - 1) {
      if (buffer[offset] !== 0xFF) break;
      const marker = buffer[offset + 1];
      if (marker === 0xC0 || marker === 0xC1 || marker === 0xC2) {
        return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
      }
      const segLen = buffer.readUInt16BE(offset + 2);
      offset += 2 + segLen;
    }
  }
  // WebP
  if (buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50) {
    if (buffer[12] === 0x56 && buffer[13] === 0x50 && buffer[14] === 0x38 && buffer[15] === 0x20) {
      return { width: buffer.readUInt16BE(26) & 0x3FFF, height: buffer.readUInt16BE(28) & 0x3FFF };
    }
    if (buffer[12] === 0x56 && buffer[13] === 0x50 && buffer[14] === 0x38 && buffer[15] === 0x4C) {
      const bits = buffer.readUInt32LE(21);
      return { width: (bits & 0x3FFF) + 1, height: ((bits >> 14) & 0x3FFF) + 1 };
    }
  }
  return null;
}

// ===== 工具函数：通用 HTTP 请求 =====
function httpRequest(url, options, body) {
  const maxRedirects = options.maxRedirects || 5;
  
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
      // 处理重定向
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && maxRedirects > 0) {
        const location = res.headers.location;
        if (location) {
          const nextUrl = location.startsWith('http') ? location : new URL(location, url).href;
          return httpRequest(nextUrl, { ...options, maxRedirects: maxRedirects - 1 }, body)
            .then(resolve).catch(reject);
        }
      }
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
      req.write(body);
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
async function cozeWorkflowRun(prompt, imageUrl, imageSize) {
  if (!COZE_API_KEY || !COZE_WORKFLOW_ID) {
    throw new Error('请配置 COZE_API_KEY 和 COZE_WORKFLOW_ID 环境变量');
  }

  // 构建工作流参数
  const parameters = {
    prompt: prompt,
  };

  // 如果有参考图片，添加 image 参数
  if (imageUrl) {
    parameters.image_url = imageUrl;
  }

  // 传入目标生成尺寸（短边1080，长边按比例）
  if (imageSize) {
    parameters.width = String(imageSize.width);
    parameters.height = String(imageSize.height);
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

  // 提取 debug_url
  const debugUrl = result.debug_url || '';

  // 解析工作流输出 - Coze 返回的 data 是字符串化的 JSON
  let outputData;
  try {
    outputData = JSON.parse(result.data);
  } catch (e) {
    // 如果 data 本身就是 URL
    if (typeof result.data === 'string' && result.data.startsWith('http')) {
      return { imageUrl: result.data, debugUrl };
    }
    throw new Error(`工作流输出解析失败: ${e.message}, raw: ${result.data?.substring(0, 200)}`);
  }

  // 尝试多种输出格式
  let foundUrl = null;
  // 格式1: { data: "https://..." }
  if (outputData.data) {
    if (typeof outputData.data === 'string' && outputData.data.startsWith('http')) {
      foundUrl = outputData.data;
    } else if (typeof outputData.data === 'object' && outputData.data.output) {
      const output = outputData.data.output;
      if (typeof output === 'string' && output.startsWith('http')) {
        foundUrl = output;
      } else if (Array.isArray(output) && output.length > 0) {
        const firstItem = output[0];
        if (typeof firstItem === 'string' && firstItem.startsWith('http')) foundUrl = firstItem;
        else if (firstItem?.url) foundUrl = firstItem.url;
        else if (firstItem?.image_url) foundUrl = firstItem.image_url;
      }
    }
  }

  // 格式4: { output: "https://..." }
  if (!foundUrl && outputData.output) {
    if (typeof outputData.output === 'string' && outputData.output.startsWith('http')) {
      foundUrl = outputData.output;
    } else if (Array.isArray(outputData.output) && outputData.output.length > 0) {
      const firstItem = outputData.output[0];
      if (typeof firstItem === 'string' && firstItem.startsWith('http')) foundUrl = firstItem;
      else if (firstItem?.url) foundUrl = firstItem.url;
      else if (firstItem?.image_url) foundUrl = firstItem.image_url;
    }
  }

  // 格式5: 直接是 URL
  if (!foundUrl && typeof outputData === 'string' && outputData.startsWith('http')) {
    foundUrl = outputData;
  }

  if (foundUrl) {
    return { imageUrl: foundUrl, debugUrl };
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
    const prompt = buildSinglePrompt(direction);
    const targetSize = calculateTargetSize(imageFile.buffer);

    // 上传图片到 OBS 获取公开 URL（工作流需要可访问的图片 URL）
    const imageUrl = await fileToPublicUrl(imageFile, 'single');

    console.log(`[生成] direction=${direction}, 图片大小=${(imageFile.size/1024).toFixed(1)}KB, 生成尺寸=${targetSize ? targetSize.width+'x'+targetSize.height : '默认'}`);

    // 调用 Coze Workflow API 生成图片
    const { imageUrl: resultUrl, debugUrl } = await cozeWorkflowRun(prompt, imageUrl, targetSize);

    // 将生成图下载并上传到 OBS（带时间戳文件名）
    const obsUrl = await downloadAndUploadToOBS(resultUrl, 'single');

    // 记录历史
    addHistory({
      id: crypto.randomUUID(),
      direction,
      imageUrl: obsUrl,
      debugUrl,
      sourceSize: imageFile.size,
      timestamp: new Date().toISOString(),
    });

    console.log(`[生成成功] OBS: ${obsUrl}`);
    res.json({ success: true, imageUrl: obsUrl, debugUrl });

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
    const prompt = buildDualPrompt(direction);
    const targetSize = calculateTargetSize(refFile.buffer);
    const refUrl = await fileToPublicUrl(refFile, 'dual');

    console.log(`[双图生成] direction=${direction}, 生成尺寸=${targetSize ? targetSize.width+'x'+targetSize.height : '默认'}`);

    // 调用 Coze Workflow API 生成图片
    const { imageUrl: resultUrl, debugUrl } = await cozeWorkflowRun(prompt, refUrl, targetSize);

    // 将生成图下载并上传到 OBS（带时间戳文件名）
    const obsUrl = await downloadAndUploadToOBS(resultUrl, 'dual');

    // 记录历史
    addHistory({
      id: crypto.randomUUID(),
      direction,
      imageUrl: obsUrl,
      debugUrl,
      timestamp: new Date().toISOString(),
    });

    console.log(`[双图生成成功] OBS: ${obsUrl}`);
    res.json({ success: true, imageUrl: obsUrl, direction, debugUrl });

  } catch (err) {
    console.error('双图生成失败:', err);
    res.status(500).json({ error: `生成失败: ${err.message}` });
  }
});

// ===== 自定义提示词（持久化到 prompts.json） =====
const fs = require('fs');
const PROMPTS_FILE = path.join(__dirname, 'prompts.json');
const HISTORY_FILE = path.join(__dirname, 'history.json');

// ===== 历史记录 =====
function loadHistory() {
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('[History] 读取失败:', e.message);
  }
  return [];
}

function saveHistory(history) {
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2), 'utf8');
}

function addHistory(record) {
  const history = loadHistory();
  history.unshift(record); // 最新的在最前面
  if (history.length > 200) history.length = 200; // 最多保留200条
  saveHistory(history);
}

// 历史记录 API
app.get('/api/history', (req, res) => {
  res.json(loadHistory());
});

app.delete('/api/history/:id', (req, res) => {
  const history = loadHistory();
  const idx = history.findIndex(h => h.id === req.params.id);
  if (idx >= 0) {
    history.splice(idx, 1);
    saveHistory(history);
    res.json({ success: true });
  } else {
    res.status(404).json({ error: '记录不存在' });
  }
});

app.delete('/api/history', (req, res) => {
  saveHistory([]);
  res.json({ success: true });
});

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
function buildSinglePrompt(direction) {
  if (direction === 'cat-to-human') {
    return customPrompts['cat-to-human'];
  } else {
    return customPrompts['human-to-cat'];
  }
}

function buildDualPrompt(direction) {
  if (direction === 'generate-human') {
    return customPrompts['cat-to-human'];
  } else {
    return customPrompts['human-to-cat'];
  }
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
