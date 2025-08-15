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
