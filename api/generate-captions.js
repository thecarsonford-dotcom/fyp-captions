// api/generate-captions.js
// POST /api/generate-captions
// Body: { product, audience, benefits[], pains[], tone, length, platform, count?, hashCount? }
// Returns: { combined: string, captions: string[], hashtags: string[] }

const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const MODEL = "gpt-4o-mini"; // fast + high quality

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

function clamp(n, min, max) {
  n = Number(n);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

// FaceTime-with-a-friend, human-first, no ad-speak
const SYSTEM_PROMPT = `
You are "Caption Catalyst" for FYP Insights Pro — an expert short-form creator.
Your captions must read like you're on FaceTime with a best friend: casual, specific, a little playful, never salesy.
Strict rules:
- Start with a natural HOOK (one short line). No clickbait words like "must-have", "insane", "game-changer".
- One tangible BENEFIT anchored to the user's pains/outcomes. No vague fluff.
- One crisp CTA aligned to the goal (tap/see how it works/follow/comment). Conversational, not pushy.
- Emojis: sparingly, for scannability (line ends or section breaks). Never spam.
- Hashtags: lowercase, space-separated, no punctuation, exactly the requested count. Mix broad, mid, category, and niche SEO.
- Output JSON ONLY in the exact shape:
{
  "captions": ["..."],             // N alternatives, captions only (no hashtags)
  "hashtags": ["#a", "#b", "..."], // H tags total
  "combined": "caption\\n#tag1 #tag2 ..." // one paste-ready line
}

Tone targets to avoid:
- No ad copy, no "introducing", "limited time", "best ever".
- No corporate voice. Keep it human, specific, relaxed.

Mini example (style only; do NOT copy content):
INPUT:
  product: compact dish rack
  audience: apartment kitchens
  pains: no counter space; wet towels
  benefits: dries fast; folds flat
OUTPUT (JSON):
{
  "captions": [
    "tiny sink crew where you at? this folds flat when you're done and the towels finally dry.",
    "apt kitchen probs: zero counter. this rack pops up, drains fast, then disappears."
  ],
  "hashtags": ["#tiktokshop", "#home", "#apartment", "#organize", "#kitchen", "#kitchenhacks", "#smallspace", "#cleaningtips"],
  "combined": "zero counter space? this rack drains fast and folds flat when you're done.\\n#tiktokshop #home #apartment #organize #kitchen #kitchenhacks #smallspace #cleaningtips"
}
`.trim();

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
      hashCount = 8,
      goal = "clicks" // optional pass-through
    } = (req.body || {});

    const N = clamp(count, 2, 10);
    const HN = clamp(hashCount, 6, 12);

    const userPrompt = [
      `product: ${String(product || "—")}`,
      `audience: ${String(audience || "—")}`,
      `benefits: ${(Array.isArray(benefits) ? benefits : []).join("; ")}`,
      `pains: ${(Array.isArray(pains) ? pains : []).join("; ")}`,
      `tone: ${tone} | length: ${length} | platform: ${platform}`,
      `goal: ${goal}`,
      `alts: ${N} | hashtags: ${HN}`,
      ``,
      `Make it human, specific, and non-salesy. Avoid hype words. Be relatable & natural.`,
      `Return ONLY the JSON object as specified in the system prompt.`
    ].join("\n");

    // Short serverless timeout for snappy UX
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000); // 12s

    const resp = await fetch(OPENAI_URL, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0.75,       // a bit lower for consistency
        top_p: 0.9,
        presence_penalty: 0.2,
        frequency_penalty: 0.2,
        max_tokens: 500,         // keeps responses quick & tight
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userPrompt }
        ]
      })
    }).catch((e) => {
      throw new Error("Network/OpenAI fetch error: " + e.message);
    });
    clearTimeout(timeout);

    if (!resp.ok) {
      const detail = await resp.text().catch(() => "");
      res.status(500).json({ error: "OpenAI request failed", detail });
      return;
    }

    const data = await resp.json();
    let content = data?.choices?.[0]?.message?.content || "";

    // If model returned text with stray prose, try to extract JSON
    let jsonText = content;
    if (typeof jsonText !== "string") jsonText = JSON.stringify(jsonText || {});
    const jsonMatch = jsonText.match(/\{[\s\S]*\}$/); // greedy to last brace
    const safeText = jsonMatch ? jsonMatch[0] : jsonText;

    let parsed = {};
    try { parsed = JSON.parse(safeText); } catch { parsed = {}; }

    let captions = Array.isArray(parsed.captions) ? parsed.captions.filter(Boolean) : [];
    if (captions.length > N) captions = captions.slice(0, N);

    let hashtags = Array.isArray(parsed.hashtags) ? parsed.hashtags.filter(Boolean) : [];
    if (hashtags.length > HN) hashtags = hashtags.slice(0, HN);

    let combined = typeof parsed.combined === "string" ? parsed.combined.trim() : "";

    // Safety fill if combined is missing
    if (!combined && captions.length) {
      const line = (hashtags || []).join(" ").trim();
      combined = line ? `${captions[0]}\n${line}` : captions[0];
    }

    res.status(200).json({
      combined: combined || "",
      captions,
      hashtags
    });

  } catch (err) {
    const msg = (err && err.name === "AbortError")
      ? "Upstream timeout"
      : (err?.message || String(err));
    res.status(500).json({ error: "Server error", detail: msg });
  }
}
