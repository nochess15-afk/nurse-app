const https = require('https');

function httpsPost(url, headers, body) {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(body);
    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname,
      method: 'POST',
      headers: {
        ...headers,
        'Content-Length': Buffer.byteLength(bodyStr)
      }
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch(e) {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });
    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

exports.handler = async function(event, context) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  try {
    const CLAUDE_KEY = process.env.CLAUDE_KEY;
    if (!CLAUDE_KEY) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'APIキーが設定されていません' }) };
    }

    const rawBody = event.isBase64Encoded
      ? Buffer.from(event.body, 'base64').toString('utf-8')
      : event.body;
    const body = JSON.parse(rawBody);

    const apiHeaders = {
      'Content-Type': 'application/json',
      'x-api-key': CLAUDE_KEY,
      'anthropic-version': '2023-06-01'
    };
    // DEBUG: サーバー側リクエスト内容ログ
    const msgs = body.messages || [];
    const firstContent = msgs[0] && msgs[0].content ? msgs[0].content : [];
    console.log('[DEBUG claude.js] model:', body.model);
    console.log('[DEBUG claude.js] max_tokens:', body.max_tokens);
    console.log('[DEBUG claude.js] messages[0].content blocks数:', firstContent.length);
    firstContent.forEach(function(block, i) {
      if (block.source) {
        var data100 = block.source.data ? block.source.data.substring(0, 100) : '(なし)';
        console.log('[DEBUG claude.js] content[' + i + '] type=' + block.type + ' media_type=' + block.source.media_type + ' data_length=' + (block.source.data ? block.source.data.length : 0));
        console.log('[DEBUG claude.js] content[' + i + '] base64先頭100文字:', data100);
      } else {
        console.log('[DEBUG claude.js] content[' + i + '] type=' + block.type + ' (text block)');
      }
    });
    console.log('[DEBUG claude.js] event.body byteLength:', Buffer.byteLength(event.body), 'bytes (約', Math.round(Buffer.byteLength(event.body) / 1024), 'KB)');

    const result = await httpsPost(
      'https://api.anthropic.com/v1/messages',
      apiHeaders,
      {
        model: body.model,
        max_tokens: body.max_tokens || 2000,
        system: body.system,
        messages: body.messages
      }
    );
    console.log('[DEBUG claude.js] API response status:', result.status);
    console.log('[DEBUG claude.js] APIレスポンス全文:', JSON.stringify(result.body));

    return {
      statusCode: result.status,
      headers,
      body: JSON.stringify(result.body)
    };

  } catch(e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};
