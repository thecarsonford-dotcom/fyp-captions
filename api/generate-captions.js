// Serverless function for Vercel (Node 18).
// POST /api/generate-captions
// Body: { product, audience, benefits[], pains[], tone, length, platform, count?, hashCount? }
// Returns: {
//   captions: string[],
//   hashtags_sets: string[][],
//   combined: string[] // "caption\n#tag1 #tag2 …"
// }

const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const MODEL = "gpt-4o-mini"; // fast + high quality

// Simple CORS helper (so you can call from any page on your domain)
function setCORS(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

module.exports = async (req, res) => {
  setCORS(res);

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

    // Guard rails (keeps latency low)
    const N = Math.max(3, Math.min(12, Number(count) || 8));
    const HN = Math.max(4, Math.min(15, Number(hashCount) || 8));

    // “FaceTime with a best friend” style system prompt
    const systemPrompt = `
You are "Caption Catalyst" for FYP Insights Pro — an expert TikTok creator who writes viral captions.
Voice & Style:
- Sound like a friend on FaceTime: casual, specific, a little playful, zero ad-speak.
- Hook fast. One concrete benefit. One crisp CTA aligned to the goal. Keep fluff out.
- Emojis: use sparingly for scannability (if helpful). No emoji spam.

Hashtag Strategy:
- Output a single line of hashtags per option (lowercase, no punctuation), spaced with a single space.
- Mix: 2-3 broad (#fyp, #tiktokshop, etc.), 2-3 category/mid, 3-5 niche/SEO relevant to product/audience.
- Never repeat the same set verbatim. Keep each set distinct.

Formatting (IMPORTANT):
Return strict JSON with this shape ONLY:
{
  "captions": ["..."],             // ${N} captions, each without hashtags
  "hashtags_sets": [["#a","#b"]],  // ${N} arrays, each with ~${HN} hashtags
  "combined": ["caption\\n#tag1 #tag2 ..."] // ${N} items, copy/paste ready
}
No extra keys, comments, or prose.
`.trim();

    // Build the user prompt concisely (lower token cost, faster)
    const userPrompt = `
Product: ${product || "—"}
Audience: ${audience || "—"}
Benefits: ${Array.isArray(benefits) ? benefits.join("; ") : benefits}
Pains: ${Array.isArray(pains) ? pains.join("; ") : pains}
Tone: ${tone} | Length: ${length} | Platform: ${platform}
Count: ${N} | Hashtags per set: ${HN}

Make the captions feel human and specific, not salesy.
Examples of good openers (do NOT reuse verbatim): 
- "okay real talk — ..."
- "quick tip if you're dealing with ..."
- "i finally found a fix for ..."
Keep each caption distinct. 
`.trim();

    const resp = await fetch(OPENAI_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0.9,     // friendly/creative but not chaotic
        top_p: 0.9,
        presence_penalty: 0.3,
        frequency_penalty: 0.2,
        // compact outputs → faster, cheaper
        max_tokens: 650,
        response_format: { type: "json_object" }, // enforce JSON
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt }
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
      // extremely rare — fallback to empty structure
      parsed = { captions: [], hashtags_sets: [], combined: [] };
    }

    // Light validation & trimming
    const caps = Array.isArray(parsed.captions) ? parsed.captions.slice(0, N) : [];
    const sets = Array.isArray(parsed.hashtags_sets) ? parsed.hashtags_sets.slice(0, N).map(s =>
      (Array.isArray(s) ? s : []).map(t => String(t).trim()).filter(Boolean).slice(0, HN)
    ) : [];
    const combo = Array.isArray(parsed.combined) ? parsed.combined.slice(0, N) : [];

    // If “combined” missing, build it
    const combined = combo.length === N && combo.every(x => typeof x === "string" && x.includes("#"))
      ? combo
      : caps.map((c, i) => {
          const line = (sets[i] || []).join(" ").trim();
          return line ? `${c}\n${line}` : c;
        });

    res.status(200).json({
      captions: caps,
      hashtags_sets: sets,
      combined: combined
    });

  } catch (err) {
    res.status(500).json({ error: "Server error", detail: String(err?.message || err) });
  }
};
