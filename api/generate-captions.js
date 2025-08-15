// api/generate-captions.js
export const config = {
  runtime: 'nodejs20.x'
};

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// --- small helpers ---
function json(res, code, obj) {
  return new Response(JSON.stringify(obj), {
    status: code,
    headers: { 'content-type': 'application/json' }
  });
}// File: /api/generate-captions.js
// Vercel Serverless Function (Node.js 18+)

const MODEL = 'gpt-4o-mini';          // fast + high quality
const TIMEOUT_MS = 18000;             // keep under Vercel 10s-20s window
const MAX_TOKENS = 280;

function json(res, code, body) {
  res.status(code).setHeader('Content-Type', 'application/json');
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.end(JSON.stringify(body));
}

function buildSystemPrompt() {
  return `You are my witty best friend on FaceTime helping me write a TikTok caption.
Write like a human, not an ad. Keep it casual, playful, a little messy if needed.

Rules:
- No corporate phrases like "introducing", "available now", "game-changer".
- Sound like gossip/tips you'd tell a close friend.
- 1 punchy sentence for the caption (max ~15 words). Natural emoji are OK. No hashtags in the caption text.
- Then a space, then 12–15 hashtags: mostly niche + SEO tags, a few trend tags. Avoid #fyp #viral spam.
- Keep brand mentions if provided, but don't overdo it.
- Return JSON ONLY in this exact schema:

{
  "combined": "caption (one sentence) + space + all hashtags in one line, ready to paste",
  "captions": ["alt option 1", "alt option 2"],
  "hashtags": ["tag1","tag2","...no # symbol"]
}`;
}

function buildUserPrompt({ product, audience, benefits, pains, tone, length, platform }) {
  const toList = (x) => Array.isArray(x) ? x.filter(Boolean).join(', ') : (x || '');
  return `Make me sound like I'm talking to my best friend about a TikTok I'm posting.

Context
- Product: ${product || '—'}
- Audience: ${audience || '—'}
- Biggest wins: ${toList(benefits)}
- Annoyances solved: ${toList(pains)}
- Tone hint: ${tone || 'casual'}
- Length: ${length || 'short'}
- Platform: ${platform || 'TikTok'}

Output: JSON only (no commentary).`;
}

function coerceArray(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') {
    return v.split(/\s*;\s*|\s*,\s*/).filter(Boolean);
  }
  return [];
}

function sanitizePayload(body) {
  return {
    product: (body.product || '').toString().slice(0, 120),
    audience: (body.audience || '').toString().slice(0, 160),
    benefits: coerceArray(body.benefits).slice(0, 8),
    pains: coerceArray(body.pains).slice(0, 8),
    tone: (body.tone || '').toString().slice(0, 40),
    length: (body.length || '').toString().slice(0, 20),
    platform: (body.platform || 'TikTok').toString().slice(0, 40),
  };
}

async function openAIChat({ apiKey, messages, signal }) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      messages,
      temperature: 0.85,
      top_p: 0.9,
      max_tokens: MAX_TOKENS,
      response_format: { type: 'json_object' }, // return valid JSON
    }),
    signal,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`OpenAI ${res.status}: ${text}`);
  }
  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content || '';
  return content;
}

function parseJsonSafe(s) {
  try { return JSON.parse(s); } catch { return null; }
}

function fallbackFromText(text) {
  // If model didn't give JSON (shouldn't happen), try to salvage
  const line = (text || '').trim().replace(/\n+/g, ' ');
  const hashPart = line.match(/(#\w[\w\d_]*(\s|$))+$/i);
  const hashtags = hashPart ? hashPart[0]
    .trim()
    .split(/\s+/)
    .map(h => h.replace(/^#/, ''))
    .filter(Boolean) : [];
  const caption = hashPart ? line.slice(0, line.length - hashPart[0].length).trim() : line;
  return {
    combined: line || '',
    captions: caption ? [caption] : [],
    hashtags,
  };
}

export default async function handler(req, res) {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.status(204);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    return res.end();
  }

  if (req.method !== 'POST') {
    return json(res, 405, { error: 'Method not allowed' });
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return json(res, 500, { error: 'Missing OPENAI_API_KEY env var' });

  let body = {};
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
  } catch (_) {
    return json(res, 400, { error: 'Invalid JSON body' });
  }

  const payload = sanitizePayload(body);

  // Timeout
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const system = buildSystemPrompt();
    const user = buildUserPrompt(payload);

    const content = await openAIChat({
      apiKey,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      signal: controller.signal,
    });

    clearTimeout(t);

    // Try clean JSON first
    let parsed = parseJsonSafe(content);

    // Normalize shape
    if (!parsed || typeof parsed !== 'object') {
      parsed = fallbackFromText(content);
    } else {
      parsed.captions = Array.isArray(parsed.captions) ? parsed.captions : [];
      parsed.hashtags = Array.isArray(parsed.hashtags) ? parsed.hashtags : [];
      // Ensure combined exists
      if (!parsed.combined) {
        const cap = parsed.captions[0] || '';
        const tags = parsed.hashtags.map(h => '#' + h.replace(/^#/, '')).join(' ');
        parsed.combined = [cap, tags].filter(Boolean).join(' ').trim();
      }
    }

    // Trim and dedupe hashtags; keep to ~15
    const cleanTags = Array.from(new Set(
      (parsed.hashtags || []).map(h => h.replace(/^#/, '').toLowerCase().trim())
    )).filter(Boolean).slice(0, 15);

    // Rebuild combined as final single line
    const combined = (() => {
      const cap = (parsed.combined || parsed.captions?.[0] || '').trim();
      const tagLine = cleanTags.map(h => `#${h}`).join(' ');
      return [cap, tagLine].filter(Boolean).join(' ').trim();
    })();

    return json(res, 200, {
      combined,
      captions: parsed.captions?.slice(0, 3) || [],
      hashtags: cleanTags,
      meta: { model: MODEL }
    });

  } catch (err) {
    const msg = (err && err.message) || 'Unknown error';
    const timeout = /aborted|timeout|The user aborted a request/i.test(msg);
    clearTimeout(t);
    return json(res, timeout ? 504 : 500, {
      error: timeout ? 'Function timeout' : 'OpenAI request failed',
      detail: msg
    });
  }
}


function safeArr(v) {
  return Array.isArray(v) ? v : typeof v === 'string' ? v.split(/\s*;\s*/).filter(Boolean) : [];
}

function buildSystemPrompt() {
  return `You are Caption Forge: a senior short-form copywriter.
- Platform defaults to TikTok unless specified.
- Voice: human, lively, concise, zero fluff.
- Output must be authentic and colloquial—no "as an AI".
- Use 1 killer caption line (emoji is okay, 1–2 max), then ~12–18 hashtags that mix SEO + niche + trend.
- Keep characters social-safe (no banned words).

Return JSON:
{
  "combined": "one single copy/paste line containing the caption followed by a space and all hashtags",
  "captions": ["alt caption 1","alt caption 2"],
  "hashtags": ["tag1","tag2","..."]
}`;
}

function buildUserPrompt({ product, audience, benefits, pains, tone, length, platform }) {
  const hints = [];
  if (product) hints.push(`Product: ${product}`);
  if (audience) hints.push(`Audience: ${audience}`);
  if (benefits?.length) hints.push(`Benefits: ${benefits.join(', ')}`);
  if (pains?.length) hints.push(`Pain points: ${pains.join(', ')}`);
  if (tone) hints.push(`Tone: ${tone}`);
  if (length) hints.push(`Length: ${length}`);
  if (platform) hints.push(`Platform: ${platform}`);

  // Preference rules to keep outputs punchy & human:
  const rules = [
    'Start with a clear, human line. No salesy filler.',
    'Sound like a real creator, not corporate.',
    'If using emojis, keep them purposeful (<=2).',
    'Hashtags: 12–18 total. Blend SEO (#chickencoop), niche (#backyardchickens), trend (#urbanfarming), brand/model if applicable.',
    'Avoid generic spam tags (#fyp #viral #xyzbca).',
    'If price/value matters, highlight it without sounding cheap.'
  ];

  return `${hints.join('\n')}
Preferences:
- ${rules.join('\n- ')}

Deliver the JSON only.`;
}

// Compact fallback prompt for speed
function buildFallbackPrompt({ product, audience, benefits, pains }) {
  const line = [
    product ? `Product: ${product}` : '',
    audience ? `Audience: ${audience}` : '',
    benefits?.length ? `Benefits: ${benefits.join(', ')}` : '',
    pains?.length ? `Pains: ${pains.join(', ')}` : ''
  ].filter(Boolean).join(' | ');

  return `Write ONE short human caption + 12–18 smart hashtags (no #fyp/#viral). Return JSON:
{
  "combined":"<caption> <#tag1> <#tag2> ..."
}
Context: ${line || 'short-form product post'}`;
}

async function openaiChat({ model, messages, temperature = 0.85, top_p = 0.95, max_tokens = 450, signal }) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'authorization': `Bearer ${OPENAI_API_KEY}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      model,
      temperature,
      top_p,
      presence_penalty: 0.2,
      frequency_penalty: 0.3,
      response_format: { type: 'json_object' },
      max_tokens,
      messages
    }),
    signal
  });
  if (!res.ok) {
    const t = await res.text().catch(()=>'');
    throw new Error(`OpenAI ${res.status}: ${t}`);
  }
  const data = await res.json();
  return data?.choices?.[0]?.message?.content || '{}';
}

export default async function handler(req) {
  try {
    if (req.method !== 'POST') {
      return json(null, 405, { error: 'Method not allowed' });
    }
    if (!OPENAI_API_KEY) {
      return json(null, 500, { error: 'Missing OPENAI_API_KEY' });
    }

    const body = await req.json().catch(()=> ({}));
    const payload = {
      product: (body.product || '').trim(),
      audience: (body.audience || '').trim(),
      benefits: safeArr(body.benefits),
      pains: safeArr(body.pains),
      tone: (body.tone || '').trim(),
      length: (body.length || '').trim(),
      platform: (body.platform || 'tiktok').trim()
    };

    // 1) Try full “god-tier” prompt with tight timeout
    const controller = new AbortController();
    const t = setTimeout(()=> controller.abort(new Error('timeout')), 30000); // 30s cap
    let content;
    try {
      content = await openaiChat({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: buildSystemPrompt() },
          { role: 'user', content: buildUserPrompt(payload) }
        ],
        max_tokens: 450,
        temperature: 0.85,
        top_p: 0.95,
        signal: controller.signal
      });
    } catch (err) {
      clearTimeout(t);
      // 2) Fallback: compact prompt, even faster
      const controller2 = new AbortController();
      const t2 = setTimeout(()=> controller2.abort(new Error('timeout')), 20000);
      try {
        content = await openaiChat({
          model: 'gpt-4o-mini',
          messages: [
            { role: 'system', content: 'Return ONLY valid JSON.' },
            { role: 'user', content: buildFallbackPrompt(payload) }
          ],
          max_tokens: 280,
          temperature: 0.9,
          top_p: 0.95,
          signal: controller2.signal
        });
      } catch (e2) {
        clearTimeout(t2);
        return json(null, 504, { error: 'Timeout', detail: String(e2.message || e2) });
      }
      clearTimeout(t2);
      // Parse & normalize fallback
      let out = {};
      try { out = JSON.parse(content); } catch {}
      const combined = (out.combined || '').toString().trim();
      if (combined) {
        return json(null, 200, { combined, captions: [combined], hashtags: [] });
      }
      // worst-case graceful degrade
      return json(null, 200, { combined: '', captions: [], hashtags: [] });
    }
    clearTimeout(t);

    // Parse primary result
    let result = {};
    try { result = JSON.parse(content); } catch {}

    // Normalize shape
    const combined = (result.combined || '').toString().trim();
    const captions = Array.isArray(result.captions) ? result.captions : (combined ? [combined] : []);
    const hashtags = Array.isArray(result.hashtags) ? result.hashtags : [];

    return json(null, 200, { combined, captions, hashtags });
  } catch (e) {
    return json(null, 500, { error: 'OpenAI request failed', detail: String(e.message || e) });
  }
}
