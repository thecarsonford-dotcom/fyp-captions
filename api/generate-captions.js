// /api/generate-captions.js
// Generates captions & hashtags for TikTok videos in a human, FaceTime-style tone.

const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const MODEL = "gpt-4o-mini"; // fast + high quality

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

module.exports = async (req, res) => {
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
      count = 8,
      hashCount = 8
    } = (req.body || {});

    const N = Math.max(2, Math.min(8, Number(count) || 6));
    const HN = Math.max(6, Math.min(12, Number(hashCount) || 8));

    const system = `
You are "Caption Catalyst" for FYP Insights Pro — an expert TikTok creator.
Voice:
- Sounds like telling a best friend on FaceTime. Casual, specific, playful. Zero ad-speak.
- Start with a hook, one tangible benefit, one crisp CTA. No fluff.
Hashtags:
- One line, lowercase, space-separated, ${HN} total.
- Mix broad (#fyp, #tiktokshop), category/mid, and niche/SEO for product+audience.
JSON ONLY in this exact shape:
{
  "captions": ["..."],             // ${N} alternatives, no hashtags
  "hashtags": ["#a","#b", "..."],  // ~${HN} tags
  "combined": "caption\\n#tag1 #tag2 ..."
}
`.trim();

    const user = `
product: ${product || "—"}
audience: ${audience || "—"}
benefits: ${(Array.isArray(benefits)?benefits:[]).join("; ")}
pains: ${(Array.isArray(pains)?pains:[]).join("; ")}
tone: ${tone} | length: ${length} | platform: ${platform}
alts: ${N} | hashtags: ${HN}

Make it human, specific, and non-salesy. Avoid hype words. Be relatable & natural.
`.trim();

    const resp = await fetch(OPENAI_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0.85,
        top_p: 0.9,
        presence_penalty: 0.2,
        frequency_penalty: 0.2,
        max_tokens: 550,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: system },
          { role: "user", content: user }
        ]
      })
    });

    if (!resp.ok) {
      const detail = await resp.text().catch(() => "");
      res.status(500).json({ error: "OpenAI request failed", detail });
      return;
    }

    const data = await resp.json();
    const content = data?.choices?.[0]?.message?.content || "{}";
    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch {
      parsed = {};
    }

    let captions = Array.isArray(parsed.captions) ? parsed.captions.filter(Boolean) : [];
    if (captions.length > N) captions = captions.slice(0, N);

    let hashtags = Array.isArray(parsed.hashtags) ? parsed.hashtags.filter(Boolean) : [];
    if (hashtags.length > HN) hashtags = hashtags.slice(0, HN);

    let combined = typeof parsed.combined === "string" ? parsed.combined.trim() : "";

    if (!combined && captions.length) {
      const line = hashtags.join(" ").trim();
      combined = line ? `${captions[0]}\n${line}` : captions[0];
    }

    res.status(200).json({
      combined: combined || "",
      captions,
      hashtags
    });

  } catch (err) {
    res.status(500).json({ error: "Server error", detail: String(err?.message || err) });
  }
};