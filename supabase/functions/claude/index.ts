import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json',
  'Cache-Control': 'no-cache, no-store, must-revalidate',
};

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('', { status: 200, headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method Not Allowed' }), { status: 405, headers: corsHeaders });
  }

  try {
    const CLAUDE_KEY = Deno.env.get('CLAUDE_KEY');
    if (!CLAUDE_KEY) {
      return new Response(JSON.stringify({ error: 'APIキーが設定されていません' }), { status: 500, headers: corsHeaders });
    }

    const body = await req.json();

    const apiHeaders: Record<string, string> = {
      'Content-Type': 'application/json',
      'x-api-key': CLAUDE_KEY,
      'anthropic-version': '2023-06-01',
    };

    // DEBUG
    const msgs = body.messages || [];
    const firstContent = msgs[0]?.content || [];
    console.log('[DEBUG claude/index.ts] model:', body.model);
    console.log('[DEBUG claude/index.ts] max_tokens:', body.max_tokens);
    console.log('[DEBUG claude/index.ts] messages[0].content blocks数:', firstContent.length);
    firstContent.forEach((block: any, i: number) => {
      if (block.source) {
        console.log(`[DEBUG] content[${i}] type=${block.type} media_type=${block.source.media_type} data_length=${block.source.data?.length ?? 0}`);
      } else {
        console.log(`[DEBUG] content[${i}] type=${block.type} (text block)`);
      }
    });

    const apiResponse = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: apiHeaders,
      body: JSON.stringify({
        model: body.model || 'claude-sonnet-4-20250514',
        max_tokens: body.max_tokens || 1000,
        system: body.system,
        messages: body.messages || [{ role: 'user', content: 'test' }],
      }),
    });

    const result = await apiResponse.json();
    console.log('[DEBUG claude/index.ts] API response status:', apiResponse.status);
    console.log('[DEBUG claude/index.ts] APIレスポンス全文:', JSON.stringify(result));

    return new Response(JSON.stringify(result), { status: apiResponse.status, headers: corsHeaders });

  } catch (e: any) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: corsHeaders });
  }
});
