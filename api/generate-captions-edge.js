// /api/generate-captions-edge.js
// Edge runtime = super fast, no cold starts
export const runtime = 'edge';

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const MODEL = 'gpt-4o-mini'; // fast + strong

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      // very permissive CORS so it also works when testing from a different origin
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'POST, OPTIONS',
      'access-control-allow-headers': 'content-type, authorization'
    }
  });
}

export default async function handler(req) {
  if (req.method === 'OPTIONS') return json({ ok: true });
  if (req.method !== 'POST') return json({ error: 'Method Not Allowed' }, 405);

  try {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return json({ error: 'Missing OPENAI_API_KEY' }, 500);

    const body = await req.json().catch(() => ({}));

    const {
      product = '',
      audience = '',
      benefits = [],
      pains = [],
      tone = 'bold',
      length = 'medium',
      platform = 'tiktok',
      count = 6,
      hashCount = 8
    } = body;

    const N = Math.max(2, Math.min(8, Number(count) || 6));
    const HN = Math.max(6, Math.min(12, Number(hashCount) || 8));

    // ——— System prompt tuned for affiliate voice (no "our", no brand ad-speak)
    const system = `
You are "Caption Catalyst" for FYP Insights Pro — an expert TikTok affiliate creator.
VOICE
- Talk like you're on FaceTime with your best friend. Casual, specific, honest.
- You're an affiliate reviewer, not the brand. Avoid "we/our". Use "I/me/my" only when personal experience fits.
- No salesy fluff. No generic hype. Keep it human and relatable.

STRUCTURE
- Start with a tight hook that names a real pain or curiosity.
- One tangible benefit/outcome.
- One crisp CTA (tap/see how it works/share/follow/etc) — match the platform.

HASHTAGS
- One line, lowercase, space-separated, ${HN} total.
- Mix broad (#fyp, #tiktokshop), category/mid, and niche/SEO for product+audience.

OUTPUT — JSON ONLY in EXACT shape:
{
  "captions": ["..."],             // ${N} alternatives, NO hashtags inside
  "hashtags": ["#a","#b","..."],   // ~${HN} tags
  "combined": "caption\\n#tag1 #tag2 ..." // one paste-ready line (caption + tags)
}
`.trim();

    const user = `
product: ${product || '—'}
audience: ${audience || '—'}
benefits: ${(Array.isArray(benefits) ? benefits : []).join('; ')}
pains: ${(Array.isArray(pains) ? pains : []).join('; ')}
tone: ${tone} | length: ${length} | platform: ${platform}
alts: ${N} | hashtags: ${HN}

STYLE GUARDRAILS
- Sound like a person, not a brand. If unsure, prefer "I found", "I switched", "this saved me", etc.
- No claims you can't stand behind. Keep it grounded. 
- Emojis: sprinkle for scannability, not glitter.
`.trim();

    const resp = await fetch(OPENAI_URL, {
      method: 'POST',
      headers: {
        'authorization': `Bearer ${apiKey}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0.85,
        top_p: 0.9,
        presence_penalty: 0.2,
        frequency_penalty: 0.2,
        max_tokens: 480,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user }
        ]
      })
    });

    if (!resp.ok) {
      const detail = await resp.text().catch(() => '');
      return json({ error: 'OpenAI request failed', detail }, 500);
    }

    const data = await resp.json();
    const content = data?.choices?.[0]?.message?.content || '{}';

    let parsed = {};
    try { parsed = JSON.parse(content); } catch {}

    let captions = Array.isArray(parsed.captions) ? parsed.captions.filter(Boolean) : [];
    if (captions.length > N) captions = captions.slice(0, N);

    let hashtags = Array.isArray(parsed.hashtags) ? parsed.hashtags.filter(Boolean) : [];
    if (hashtags.length > HN) hashtags = hashtags.slice(0, HN);

    let combined = typeof parsed.combined === 'string' ? parsed.combined.trim() : '';
    if (!combined && captions.length) {
      const line = hashtags.join(' ').trim();
      combined = line ? `${captions[0]}\n${line}` : captions[0];
    }

    return json({ combined: combined || '', captions, hashtags });
  } catch (err) {
    return json({ error: 'Server error', detail: String(err?.message || err) }, 500);
  }
}
