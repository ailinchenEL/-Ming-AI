const http = require('http');
const fs = require('fs');
const path = require('path');

// 可选：读取同目录 .env（避免把密钥写进代码）
(function loadEnv() {
  const p = path.join(__dirname, '.env');
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
})();

const PORT = Number(process.env.PORT || 8787);
const ARK_API_KEY = process.env.ARK_API_KEY || '';
const ARK_MODEL = process.env.ARK_MODEL || 'doubao-seed-1-6-251015';
const ARK_BASE = process.env.ARK_BASE_URL || 'https://ark.cn-beijing.volces.com/api/v3';
const ROOT = __dirname;
const MAX_BODY = 12 * 1024 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml'
};

const PROMPT = `你是资深评茶师。请只根据图片中可见的干茶外观做判断，不要臆测。

步骤：
1. 观察并描述：干茶形态（扁平挺直 / 卷曲成螺 / 条索 / 颗粒珠形 / 饼砖 / 碎茶）、色泽（翠绿 / 墨绿 / 黄绿 / 乌褐 / 银白 / 金黄）、是否有白毫、匀整度、是否混有茶梗或碎末、拍摄背景与光线。
2. 判断图片是否为茶叶。若不是茶叶、主体不是干茶、或严重模糊 / 逆光 / 过暗，则 isTea=false，candidates 返回空数组，并在 note 说明原因。
3. 给出最多 3 个候选茶种，按可能性从高到低排序。confidence 是 0-100 的整数，必须诚实反映不确定性：仅凭色泽相近给 30-55；形态与色泽都吻合才给 70 以上；存在明显混淆项时不要超过 85。
4. reasons 每条不超过 20 字，写图片里可验证的依据。
5. difficulty 用一句话说明本次识别的难点（例如“龙井与雀舌外形相近”）。

只输出一个 JSON 对象，不要 markdown 代码块，不要多余文字。格式：
{"isTea":true,"quality":{"score":0,"issues":[]},"observed":"","candidates":[{"name":"","category":"","confidence":0,"reasons":[]}],"difficulty":"","note":""}
category 只能取：绿茶、红茶、乌龙茶、白茶、黄茶、黑茶、花茶、其他。`;

function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('图片过大，请压缩后再试'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function parseModelJSON(text) {
  const cleaned = String(text || '').trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('模型未返回 JSON');
  return JSON.parse(cleaned.slice(start, end + 1));
}

function sanitize(result) {
  const out = {
    isTea: result.isTea !== false,
    quality: {
      score: Math.max(0, Math.min(100, Number(result?.quality?.score) || 0)),
      issues: Array.isArray(result?.quality?.issues) ? result.quality.issues.slice(0, 5).map(String) : []
    },
    observed: String(result?.observed || ''),
    candidates: [],
    difficulty: String(result?.difficulty || ''),
    note: String(result?.note || '')
  };
  const list = Array.isArray(result?.candidates) ? result.candidates.slice(0, 3) : [];
  out.candidates = list.map(c => ({
    name: String(c?.name || '未知'),
    category: String(c?.category || '其他'),
    confidence: Math.max(0, Math.min(100, Math.round(Number(c?.confidence) || 0))),
    reasons: Array.isArray(c?.reasons) ? c.reasons.slice(0, 4).map(String) : []
  }));
  return out;
}

async function handleRecognize(req, res) {
  if (!ARK_API_KEY) {
    sendJSON(res, 503, { error: '服务端未配置 ARK_API_KEY，已切换到本地近似识别。' });
    return;
  }

  let body;
  try {
    body = await readBody(req);
  } catch (e) {
    sendJSON(res, 413, { error: e.message });
    return;
  }

  let image;
  try {
    image = JSON.parse(body).image;
  } catch {
    sendJSON(res, 400, { error: '请求体不是合法 JSON' });
    return;
  }

  if (typeof image !== 'string' || !/^data:image\/(png|jpe?g|webp);base64,/.test(image)) {
    sendJSON(res, 400, { error: '缺少合法的图片 dataURL' });
    return;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45000);

  try {
    const upstream = await fetch(ARK_BASE + '/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + ARK_API_KEY
      },
      body: JSON.stringify({
        model: ARK_MODEL,
        temperature: 0.1,
        max_tokens: 900,
        messages: [{
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: image } },
            { type: 'text', text: PROMPT }
          ]
        }]
      }),
      signal: controller.signal
    });

    const raw = await upstream.text();
    if (!upstream.ok) {
      sendJSON(res, 502, { error: '上游接口返回 ' + upstream.status, detail: raw.slice(0, 500) });
      return;
    }

    let content = '';
    try {
      const parsed = JSON.parse(raw);
      content = parsed?.choices?.[0]?.message?.content || '';
    } catch {
      sendJSON(res, 502, { error: '上游返回格式异常' });
      return;
    }

    const result = sanitize(parseModelJSON(content));
    sendJSON(res, 200, { result });
  } catch (e) {
    const msg = e.name === 'AbortError' ? '识别超时，请重试' : (e.message || '识别失败');
    sendJSON(res, 502, { error: msg });
  } finally {
    clearTimeout(timer);
  }
}

function serveStatic(req, res) {
  let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  if (urlPath === '/' || urlPath === '') urlPath = '/tea-mind.html';

  const filePath = path.join(ROOT, path.normalize(urlPath));
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/api/recognize-tea') {
    handleRecognize(req, res);
    return;
  }
  if (req.method === 'GET' || req.method === 'HEAD') {
    serveStatic(req, res);
    return;
  }
  res.writeHead(405);
  res.end('Method Not Allowed');
});

server.listen(PORT, () => {
  console.log('茗语已启动: http://localhost:' + PORT);
  console.log('识茶模型: ' + ARK_MODEL + (ARK_API_KEY ? '' : '（未配置 ARK_API_KEY，将使用本地近似识别）'));
});
