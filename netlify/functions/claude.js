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

    const body = JSON.parse(event.body);

    const apiHeaders = {
      'Content-Type': 'application/json',
      'x-api-key': CLAUDE_KEY,
      'anthropic-version': '2023-06-01'
    };
    if (body.usePdfBeta) {
      apiHeaders['anthropic-beta'] = 'pdfs-2024-09-25';
    }

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

    return {
      statusCode: result.status,
      headers,
      body: JSON.stringify(result.body)
    };

  } catch(e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};
