// ============================================
// 人兽替换 - 后端服务（CLI 模式）
// ============================================
// 通过 coze CLI 调用图片生成 API，自动处理认证
// 环境变量（.env 文件自动加载，系统环境变量优先级更高）：
//   PORT=8082（可选，默认8082）
// ============================================

require('dotenv').config();

const express = require('express');
const multer = require('multer');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const { execFile } = require('child_process');

const app = express();
const PORT = process.env.PORT || 8082;

// OBS 上传配置
const OBS_BASE = 'http://obs.dimond.top';

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

// ===== 工具函数：调用 coze CLI 生成图片 =====
function cozeGenerateImage(prompt, imageUrl) {
  return new Promise((resolve, reject) => {
    const args = ['generate', 'image', prompt, '--size', '2K', '--format', 'json'];
    if (imageUrl) {
      args.push('--image', imageUrl);
    }

    console.log(`[CLI] coze ${args.join(' ')}`);

    execFile('coze', args, { timeout: 120000 }, (error, stdout, stderr) => {
      if (error) {
        console.error(`[CLI] 错误: ${error.message}`);
        reject(new Error(`coze CLI 失败: ${error.message}`));
        return;
      }

      try {
        const result = JSON.parse(stdout.trim());
        if (Array.isArray(result) && result.length > 0 && result[0].url) {
          resolve(result[0].url);
        } else {
          reject(new Error('CLI 未返回有效图片 URL'));
        }
      } catch (parseErr) {
        console.error(`[CLI] 输出解析失败: ${stdout.substring(0, 200)}`);
        reject(new Error(`CLI 输出解析失败: ${parseErr.message}`));
      }
    });
  });
}

// ===== 健康检查 =====
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    mode: 'cli',
    message: '服务已就绪（coze CLI 模式）'
  });
});

// ===== 核心：单图生成 API =====
app.post('/api/generate', upload.single('image'), async (req, res) => {
  const direction = req.body.direction;
  const imageFile = req.file;

  if (!direction || !imageFile) {
    return res.status(400).json({ error: '缺少 direction 或 image 参数' });
  }

  try {
    const prompt = buildSinglePrompt(direction);

    // 上传图片到 OBS 获取公开 URL
    const imageUrl = await fileToPublicUrl(imageFile, 'single');

    console.log(`[生成] direction=${direction}, 图片大小=${(imageFile.size/1024).toFixed(1)}KB`);

    // 调用 coze CLI 生成图片
    const resultUrl = await cozeGenerateImage(prompt, imageUrl);

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
  const direction = req.body.direction;
  const catFile = req.files?.catImage?.[0];
  const humanFile = req.files?.humanImage?.[0];

  if (!direction || !catFile || !humanFile) {
    return res.status(400).json({ error: '缺少 direction、catImage 或 humanImage' });
  }

  try {
    const prompt = buildDualPrompt(direction);

    // 双图模式：参考图为目标方向的源图
    const refFile = direction === 'generate-cat' ? humanFile : catFile;
    const refUrl = await fileToPublicUrl(refFile, 'dual');

    console.log(`[双图生成] direction=${direction}`);

    // 调用 coze CLI 生成图片
    const resultUrl = await cozeGenerateImage(prompt, refUrl);

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
  console.log(`\n🐾 人兽替换服务已启动（CLI 模式）`);
  console.log(`   地址: http://localhost:${PORT}`);
  console.log(`   模式: coze CLI 子进程调用`);
  console.log(`   OBS 中转: ✅ 已启用 (${OBS_BASE})`);
  console.log();
});
