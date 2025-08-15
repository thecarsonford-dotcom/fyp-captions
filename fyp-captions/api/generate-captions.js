// /api/generate-captions.js
export const config = { runtime: 'edge' };

function sysPrompt() {
  return `You are "Hook Forge – Captions Pro", an elite short-form copywriter.
Write platform-ready TikTok captions with optional inline CTA, and a separate hashtag set.
Rules:
- Be punchy, specific, and scroll-stopping. No fluff.
- Use natural language, not spammy keyword stuffing.
- Never include more than one emoji per caption unless asked.
- Hashtags: 5–12 highly relevant, niche-first, mix of broad + mid + long-tail. No banned or misleading tags. No camelCase unless a brand.
- If product/offer is provided, anchor the hook to the *benefit* and a *pain solved*.
- Respect tone and length. Length: "short" (≤90 chars), "medium" (~120–180), "long" (≤300).
- Return clean text only. No markdown, no quotes.
Output JSON with:
{
  "captions": ["..."],
  "hashtags": ["#..."],
  "notes": "one line rationale"
}`;
}

function buildUserPrompt(payload) {
  const {
    product = '', category = '', persona = '',
    pains = [], benefits = [], goals = [],
    tone = 'neutral', length = 'medium',
    count = 12, mode = 'both'
  } = payload || {};

  return {
    role: 'user',
    content:
`Platform: TikTok
Mode: ${mode}              // captions | hashtags | both
Count: ${count}
Tone: ${tone}
Length: ${length}
Product/Offer: ${product}
Category: ${category}
Persona: ${persona}
Top pains: ${(pains||[]).join('; ')}
Key benefits: ${(benefits||[]).join('; ')}
Goals (e.g., clicks, saves, purchase): ${(goals||[]).join('; ')}

Deliver "captions" and/or "hashtags" per the mode. Keep each caption unique and hook-forward.`
  };
}

export default async function handler(req) {
  try {
    if (req.method !== 'POST') {
      return new Response(JSON.stringify({ error: 'Use POST' }), { status: 405 });
    }
    const body = await req.json();
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return new Response(JSON.stringify({ error: 'Missing OPENAI_API_KEY' }), { status: 500 });
    }

    // Build OpenAI Chat request (compatible with current v1 chat endpoints)
    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini', // fast & strong; you can swap to another model later
        temperature: 0.85,
        top_p: 0.95,
        messages: [
          { role: 'system', content: sysPrompt() },
          buildUserPrompt(body)
        ],
        response_format: { type: 'json_object' },
      }),
    });

    if (!resp.ok) {
      const t = await resp.text();
      return new Response(JSON.stringify({ error: `Upstream error`, detail: t }), { status: 500 });
    }

    const data = await resp.json();
    let parsed = {};
    try {
      const raw = data.choices?.[0]?.message?.content || '{}';
      parsed = JSON.parse(raw);
    } catch {
      parsed = { captions: [], hashtags: [], notes: 'Parser fallback.' };
    }

    // Safety: enforce arrays & trim
    const captions = Array.isArray(parsed.captions) ? parsed.captions.map(s => (s||'').trim()).filter(Boolean) : [];
    const hashtags = Array.isArray(parsed.hashtags) ? parsed.hashtags.map(s => s.replace(/\s+/g,'').trim()).filter(Boolean) : [];

    return new Response(JSON.stringify({ captions, hashtags, notes: parsed.notes || '' }), {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      status: 200
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: 'Server error', detail: String(err) }), { status: 500 });
  }
}
