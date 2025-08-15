// /api/generate.js
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST' });

  const { OPENAI_API_KEY, MODEL = 'gpt-4o-mini' } = process.env;
  if (!OPENAI_API_KEY) return res.status(500).json({ error: 'Missing OPENAI_API_KEY' });

  const body = await req.json?.().catch?.(() => null) || req.body || {};
  // Expecting full 'vars' object from the page
  const {
    product = '', category = '', audience = '', platform = 'tiktok',
    tone = 'bold', count = 12, maxHashtags = 24, banned = []
  } = body || {};

  const prompt = `
You are an elite direct-response copywriter for TikTok. Generate ${count} caption+hashtag pairs.
Constraints:
- Captions: 1–2 punchy lines, hook-first, no fluff, platform: ${platform}.
- Include a final CTA variation every 3rd caption (e.g., "watch till the end", "link in bio").
- Hashtags: ${Math.min(maxHashtags, 24)} max, mix broad + niche + product intent, avoid banned: ${banned.join(', ') || 'none'}.
- Topic: product="${product}", category="${category}", audience="${audience}", tone="${tone}".
Return strict JSON:
{ "list": [ { "caption": "...", "hashtags": ["#tag", ...] }, ... ] }`;

  async function callOpenAI() {
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0.8,
        messages: [
          { role: 'system', content: 'You write high-converting short-form captions and hashtag sets.' },
          { role: 'user', content: prompt }
        ]
      })
    });
    const j = await r.json();
    const text = j?.choices?.[0]?.message?.content || '';
    return text;
  }

  function rescueJSON(s) {
    const m = s.match(/\{[\s\S]*\}$/) || s.match(/\{[\s\S]*\}\s*```/);
    try { return JSON.parse(m ? m[0].replace(/```json|```/g, '') : s); } catch { return null; }
  }

  try {
    const raw = await callOpenAI();
    const parsed = rescueJSON(raw);
    if (parsed?.list && Array.isArray(parsed.list)) {
      // sanitize
      const list = parsed.list.map(it => ({
        caption: String(it.caption || '').trim(),
        hashtags: Array.isArray(it.hashtags) ? it.hashtags.map(String).filter(h => /^#\w/.test(h)) : []
      })).filter(x => x.caption);
      return res.status(200).json({ list });
    }
    return res.status(200).json({ list: [] });
  } catch (e) {
    return res.status(500).json({ error: e.message || 'AI error' });
  }
}
