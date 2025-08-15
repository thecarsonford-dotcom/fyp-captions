// /api/generate-captions.js
// POST /api/generate-captions
// Body: { product, audience, benefits[], pains[], tone, length, platform, count?, hashCount? }
// Returns: { combined: string, captions: string[], hashtags: string[] }

const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
// Use a fast, inexpensive model tuned for chat
const MODEL = "gpt-4o-mini";

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

export default async function handler(req, res) {
  cors(res);

  if (req.method === "OPTIONS") {
    res.status(200).end();
    return;
  }
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method Not Allowed" });
    return;
  }

  try {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      res.status(500).json({ error: "Missing OPENAI_API_KEY" });
      return;
    }

    const {
      product = "",
      audience = "",
      benefits = [],
      pains = [],
      tone = "bold",
      length = "medium",
      platform = "tiktok",
      count = 6,
      hashCount = 8
    } = (req.body || {});

    // keep outputs tight for speed and consistency
    const N = Math.max(2, Math.min(6, Number(count) || 6));
    const HN = Math.max(6, Math.min(12, Number(hashCount) || 8));

    // “FaceTime with a friend” style — no ad-speak, no brand fluff
    const system = `
You are "Caption Catalyst" for FYP Insights Pro — a senior UGC creator who writes like a best friend on FaceTime.
Style:
- Conversational, specific, lightly playful. Zero ad-speak, no corporate words.
- Use contractions. One clear benefit. One crisp CTA aligned to the goal. Keep it human.
- If you add an emoji, use max 1–2 total, only where it helps scannability (not decoration).
Hashtags:
- Output ~${HN} tags as a single space-separated line, all lowercase, no punctuation, no duplicates.
- Blend: broad (#fyp, #tiktokshop), mid/category, and niche/SEO tied to product+audience.
Return JSON ONLY in this exact shape:
{
  "captions": ["..."],             // ${N} alternatives, NO hashtags inside
  "hashtags": ["#a","#b", "..."],  // ~${HN} tags
  "combined": "caption\\n#tag1 #tag2 ..." // a single paste-ready best pick
}
`.trim();

    const user = `
product: ${product || "—"}
audience: ${audience || "—"}
benefits: ${(Array.isArray(benefits)?benefits:[]).join("; ")}
pains: ${(Array.isArray(pains)?pains:[]).join("; ")}
tone: ${tone} | length: ${length} | platform: ${platform}
alts: ${N} | hashtags: ${HN}

Constraints:
- Plain language. No buzzwords like “transform”, “ultimate”, “revolutionary”.
- Lead with the situation or pain in 5–8 words; then the benefit. CTA last.
- Captions should read like a natural text you’d send a friend, not an ad.
`.trim();

    // 12s hard timeout for snappy UX
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 12_000);

    const resp = await fetch(OPENAI_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0.7,         // a bit lower for consistency
        top_p: 0.9,
        presence_penalty: 0.2,
        frequency_penalty: 0.2,
        max_tokens: 420,          // tighter to reduce latency
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: system },
          { role: "user", content: user }
        ]
      }),
      signal: ac.signal
    }).catch((e) => {
      clearTimeout(t);
      throw e;
    });
    clearTimeout(t);

    if (!resp.ok) {
      const detail = await resp.text().catch(() => "");
      res.status(500).json({ error: "OpenAI request failed", detail });
      return;
    }

    const data = await resp.json();
    const content = data?.choices?.[0]?.message?.content || "{}";

    let parsed = {};
    try { parsed = JSON.parse(content); } catch { parsed = {}; }

    let captions = Array.isArray(parsed.captions) ? parsed.captions.filter(Boolean) : [];
    if (captions.length > N) captions = captions.slice(0, N);

    let hashtags = Array.isArray(parsed.hashtags) ? parsed.hashtags.filter(Boolean) : [];
    if (hashtags.length > HN) hashtags = hashtags.slice(0, HN);

    let combined = typeof parsed.combined === "string" ? parsed.combined.trim() : "";
    if (!combined && captions.length) {
      const line = hashtags.join(" ").trim();
      combined = line ? `${captions[0]}\n${line}` : captions[0];
    }

    res.status(200).json({ combined: combined || "", captions, hashtags });
  } catch (err) {
    const msg = (err?.name === 'AbortError') ? 'Upstream timeout' : (err?.message || String(err));
    res.status(500).json({ error: "Server error", detail: msg });
  }
}
