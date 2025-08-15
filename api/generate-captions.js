// Serverless function for Vercel
// Requires env var: OPENAI_API_KEY

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { product = '', topic = '', audience = '', tone = 'friendly', platform = 'tiktok', maxHashtags = 8 } =
      (req.body ?? {});

    const prompt = `
You are a world-class TikTok copywriter. Generate:
1) 3 short, punchy TikTok captions (each 1–2 lines, hooks up front, no fluff) for a video about:
   - Product: ${product || '(unspecified)'}
   - Topic/angle: ${topic || '(unspecified)'}
   - Audience: ${audience || '(unspecified)'}
   - Tone: ${tone}
2) A compact hashtag set optimized for TikTok discovery (max ${Math.max(3, Math.min(15, Number(maxHashtags) || 8))} tags).
3) Keep everything platform-appropriate for ${platform} and avoid banned words.

Return strictly as JSON with:
{
  "captions": ["...", "...", "..."],
  "hashtags": ["#tag1", "#tag2", ...]
}
No extra commentary.
`;

    // Call OpenAI
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: 'You write elite, high-converting short captions for TikTok.' },
          { role: 'user', content: prompt }
        ],
        temperature: 0.8
      })
    });

    if (!r.ok) {
      const text = await r.text().catch(() => '');
      return res.status(500).json({ error: 'OpenAI request failed', detail: text });
    }

    const data = await r.json();
    const raw = data?.choices?.[0]?.message?.content?.trim() || '';

    // Try parsing JSON from the model's response
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // fallback: extract JSON block if model wrapped it in text
      const match = raw.match(/\{[\s\S]*\}$/);
      parsed = match ? JSON.parse(match[0]) : { captions: [], hashtags: [] };
    }

    // Minimal guard-rails
    if (!Array.isArray(parsed.captions)) parsed.captions = [];
    if (!Array.isArray(parsed.hashtags)) parsed.hashtags = [];

    return res.status(200).json(parsed);
  } catch (err) {
    return res.status(500).json({ error: 'Server error', detail: String(err?.message || err) });
  }
}
