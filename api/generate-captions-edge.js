// /api/generate-captions-edge.js
// POST /api/generate-captions-edge
// Body: { product, audience, benefits[], pains[], tone, length, platform, count?, hashCount? }
// Returns: { combined: string, captions: string[], hashtags: string[] }

export const config = { runtime: 'edge' };

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Content-Type': 'application/json; charset=utf-8',
  };
}

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const MODEL = 'gpt-4o-mini';

export default async function handler(req) {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 200, headers: corsHeaders() });
  }
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method Not Allowed' }), {
      status: 405,
      headers: corsHeaders(),
    });
  }

  try {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return new Response(JSON.stringify({ error: 'Missing OPENAI_API_KEY' }), {
        status: 500,
        headers: corsHeaders(),
      });
    }

    const body = await req.json().catch(() => ({}));
    const {
      product = '',
      audience = '',
      benefits = [],
      pains = [],
      tone = 'bold',
      length = 'medium',
      platform = 'tiktok',
      count = 8,
      hashCount = 8,
    } = body || {};

    // Clamp counts for speed + reliability at the edge
    const N = Math.max(2, Math.min(8, Number(count) || 6));
    const HN = Math.max(6, Math.min(12, Number(hashCount) || 8));

    // Guardrails to avoid ad-speak & “our/brand voice” issues
    const system = `
You are "Caption Catalyst" for FYP Insights Pro — a world-class TikTok affiliate creator.
Write like you're on FaceTime with your best friend: specific, casual, helpful, and human.
NEVER use "we", "our", or brand-owner voice. Speak as an independent affiliate/showcaser.
Prioritize: hook → one concrete benefit → crisp CTA that fits the goal. No hype. No fluff.

Hashtags:
- Return one flat line, lowercase, space-separated, ${HN} total.
- Mix: broad (e.g. #fyp, #tiktokshop), category/mid, and niche/SEO for product+audience.
- No punctuation, no commas, no duplicates.

Output JSON ONLY in EXACT shape:
{
  "captions": ["..."],             // ${N} alternatives, WITHOUT hashtags
  "hashtags": ["#a","#b","..."],   // ~${HN} tags, space-safe tokens
  "combined": "caption\\n#tag1 #tag2 ..."  // the single best paste-ready line
}`.trim();

    const user = `
product: ${product || '—'}
audience: ${audience || '—'}
benefits: ${(Array.isArray(benefits) ? benefits : []).join('; ')}
pains: ${(Array.isArray(pains) ? pains : []).join('; ')}
tone: ${tone} | length: ${length} | platform: ${platform}
alts: ${N} | hashtags: ${HN}

Style rules:
- Sound personal and real. Show how it helps in everyday life.
- Avoid ad vibes, avoid brand voice, avoid generic filler.
- Keep emoji smart and minimal if used at all.
`.trim();

    const openaiRes = await fetch(OPENAI_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0.8,
        top_p: 0.9,
        presence_penalty: 0.2,
        frequency_penalty: 0.2,
        max_tokens: 520,
        // Some OpenAI models accept `seed`; if unsupported it's ignored.
        seed: Math.floor(Date.now() / 86400000), // daily-stable vibe
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
    });

    if (!openaiRes.ok) {
      const detail = await openaiRes.text().catch(() => '');
      return new Response(
        JSON.stringify({ error: 'OpenAI request failed', detail }),
        { status: 500, headers: corsHeaders() }
      );
    }

    const data = await openaiRes.json();
    const content = data?.choices?.[0]?.message?.content || '{}';

    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch {
      parsed = {};
    }

    let captions = Array.isArray(parsed.captions)
      ? parsed.captions.filter(Boolean)
      : [];
    if (captions.length > N) captions = captions.slice(0, N);

    let hashtags = Array.isArray(parsed.hashtags)
      ? parsed.hashtags.filter(Boolean)
      : [];
    if (hashtags.length > HN) hashtags = hashtags.slice(0, HN);

    let combined = typeof parsed.combined === 'string' ? parsed.combined.trim() : '';

    // Build fallback combined if the model omitted it
    if (!combined && captions.length) {
      const line = hashtags.join(' ').trim();
      combined = line ? `${captions[0]}\n${line}` : captions[0];
    }

    return new Response(
      JSON.stringify({
        combined: combined || '',
        captions,
        hashtags,
      }),
      { status: 200, headers: corsHeaders() }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: 'Server error', detail: String(err?.message || err) }),
      { status: 500, headers: corsHeaders() }
    );
  }
}
