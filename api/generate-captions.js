// /api/generate-captions.js
// Vercel serverless function. Expects POST JSON:
// { product, audience, benefits[], pains[], tone, length, platform }
// Returns: { captions: string[], hashtags: string[] }

export const config = { runtime: 'nodejs18.x' };

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_BASE = process.env.OPENAI_API_BASE || 'https://api.openai.com/v1';
const MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini'; // good balance of quality/cost

// ---- helpers: hygiene, dedupe, tag policy ----
const BANNED_TAGS = new Set([
  'followforfollow','f4f','likeforlike','l4l','followback','sub4sub',
  'viral', 'viraltiktok', 'explorepage', 'foru', 'fypシ', 'fyppppppp',
  'nudity', 'nsfw', 'adult', 'xxx'
]);

function uniq(arr) {
  const seen = new Set();
  const out = [];
  for (const s of arr) {
    const k = (s || '').trim().toLowerCase();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(s);
  }
  return out;
}

function cleanCaption(s) {
  let t = (s || '').trim();
  // collapse spaces & punctuation
  t = t.replace(/\s+/g, ' ')
       .replace(/\s([?!.,:;])/g, '$1')
       .replace(/[“”]/g, '"')
       .replace(/[‘’]/g, "'")
       .replace(/\.+$/,'')
       .trim();
  // keep within a sensible range for TikTok
  if (t.length > 220) {
    // try a sentence-level cut
    const parts = t.split(/(?<=[.!?])\s+/);
    let acc = '';
    for (const p of parts) {
      if ((acc + ' ' + p).trim().length > 210) break;
      acc = (acc ? acc + ' ' : '') + p;
    }
    t = acc || t.slice(0, 210);
  }
  return t;
}

function cleanTag(s) {
  let t = (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  t = t.replace(/^tiktok$/, 'tt') // avoid generic / noisy
       .replace(/^fyp$/, 'fyppro'); // brand tilt
  if (!t) return '';
  if (BANNED_TAGS.has(t)) return '';
  return t;
}

function curateHashtags(tags, { product, audience, benefits }) {
  // Clean + dedupe
  let cleaned = uniq(tags.map(cleanTag)).filter(Boolean);

  // Ensure mix: broad (3–5), niche (6–9), long-tail (2–4)
  const broadSeeds = ['fypinsights','creator','content','marketing','onlineshop','smallbusiness','ecommerce','tiktokshop','makemoney'];
  const fromInputs = uniq([
    ...(product || '').toLowerCase().split(/\s+/).slice(0,3),
    ...(audience || '').toLowerCase().split(/\s*;\s*/),
    ...((benefits||[]).flatMap(b => b.toLowerCase().split(/\s+/).slice(0,2)))
  ]).map(cleanTag).filter(Boolean);

  const broad = uniq(broadSeeds.map(cleanTag)).slice(0, 6);
  const niche = uniq([...fromInputs, ...cleaned]).slice(0, 16);
  const longTail = uniq(
    (benefits || [])
      .map(b => cleanTag(b.replace(/\s+/g, '')))
  ).slice(0, 8);

  // Compose a set: 12–18 total
  let out = uniq([
    ...broad.slice(0, 4 + Math.floor(Math.random()*2)),   // 4–5
    ...niche.slice(0, 7 + Math.floor(Math.random()*3)),    // 7–9
    ...longTail.slice(0, 2 + Math.floor(Math.random()*3)), // 2–4
  ]).filter(Boolean);

  // Guarantee brand anchor
  if (!out.includes('fypinsights')) out.unshift('fypinsights');

  // Trim size
  if (out.length < 12) {
    // pad from cleaned if short
    for (const t of cleaned) { if (!out.includes(t)) out.push(t); if (out.length >= 12) break; }
  }
  if (out.length > 18) out = out.slice(0,18);

  return out;
}

function pickCountByLength(length) {
  if (length === 'short') return 3;
  if (length === 'long') return 6;
  return 5; // medium
}

// ---- Prompt: tuned system + few-shot examples ----
function buildMessages(payload) {
  const {
    product = '',
    audience = '',
    benefits = [],
    pains = [],
    tone = '',
    length = 'medium',
    platform = 'tiktok'
  } = payload || {};

  const system = `
You are CAPTION-FORGE, a senior short-form copywriter for TikTok/Reels/Shorts.
Output must be JSON with exactly two fields: "captions" (array of strings) and "hashtags" (array of strings without #).

Non-negotiables:
- Hooks up front. 4–14 words to earn the first second.
- Concrete benefits and outcomes. Avoid fluff and vague hype.
- Natural language — no spam, no emoji spam (max 1 emoji per caption), no ALL CAPS.
- No "link in bio", no "follow for more", no engagement bait.
- Make the product the hero without sounding salesy.
- Platform="${platform}". Write for that platform's vibe; default is TikTok.
- Tone: if provided ("${tone}"), subtly reflect it (Bold, Friendly, Luxury, Scientific, Contrarian). Never overdo it.
- Length: ${length}. Keep captions within that feel.

Hashtags policy:
- 12–18 total. 30% broad, 50% niche, 20% long-tail.
- No banned/cheesy tags (e.g., followforfollow, l4l, viraltiktok). No duplicates. No # symbol in output.
- Include exactly one brand anchor: "fypinsights".
`;

  // A compact user summary (helps model stay on-target)
  const userBrief = `
Product: ${product || '(unspecified)'}
Audience: ${audience || '(unspecified)'}
Benefits: ${(benefits||[]).join('; ') || '(unspecified)'}
Pains: ${(pains||[]).join('; ') || '(unspecified)'}
Tone: ${tone || 'Auto'}
Length: ${length}
Platform: ${platform}
`;

  // Few-shot exemplars (model sees the style + JSON shape we want)
  const fewShot = [
    {
      role: 'user',
      content: `Product: 14-in-1 Veggie Chopper
Audience: busy parents; students
Benefits: 5-minute prep; fewer tools; safer fingers
Pains: slow prep; cluttered drawers
Tone: Friendly
Length: short
Platform: tiktok

Return JSON only.`
    },
    {
      role: 'assistant',
      content: JSON.stringify({
        captions: [
          "Prep dinner in 5 — without the mess.",
          "One tool, zero clutter. Watch this.",
          "Chop days to minutes (safely)."
        ],
        hashtags: [
          "fypinsights","tiktokshop","kitchenfinds","mealprep","smallspace",
          "busymom","busydad","studentlife","quickdinner","saferkitchen","onepan","tinykitchen"
        ]
      })
    },
    {
      role: 'user',
      content: `Product: Ceramide Barrier Serum
Audience: oily; sensitive skin
Benefits: barrier repair; makeup holds; glass skin
Pains: redness; breakouts; tight after cleansing
Tone: Scientific
Length: medium
Platform: tiktok

Return JSON only.`
    },
    {
      role: 'assistant',
      content: JSON.stringify({
        captions: [
          "Oily + sensitive? Start with your barrier.",
          "If makeup slides by noon, fix this first.",
          "Redness after cleansing? Here’s the why (and fix).",
          "7 days to calm, glassy skin — no 10-step routine.",
          "Derm-safe ceramides that don’t break you out."
        ],
        hashtags: [
          "fypinsights","skincare","ceramides","barrierrepair","glassskin",
          "oilyskin","sensitiveskin","dermsafe","skinbarrier","skincaretips",
          "minimalroutine","makeuplasts","skinsoothing","calmskin"
        ]
      })
    }
  ];

  const ask = {
    role: 'user',
    content: `${userBrief}\nCount: ${pickCountByLength(length)} captions.\nReturn JSON only.`
  };

  return [
    { role: 'system', content: system.trim() },
    ...fewShot,
    ask
  ];
}

// ---- OpenAI call ----
async function callOpenAI(messages) {
  const body = {
    model: MODEL,
    messages,
    temperature: 0.7,
    top_p: 0.95,
    presence_penalty: 0.1,
    frequency_penalty: 0.2,
    response_format: { type: 'json_object' }
  };
  const res = await fetch(`${OPENAI_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const detail = await res.text().catch(()=>'');
    throw new Error(`OpenAI request failed: ${res.status} ${detail}`);
  }
  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content || '{}';
  return JSON.parse(content);
}

// ---- Handler ----
export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Method not allowed' });
    }
    if (!OPENAI_API_KEY) {
      return res.status(500).json({ error: 'Missing OPENAI_API_KEY env' });
    }

    const payload = await readJson(req);
    // Build prompt
    const messages = buildMessages(payload);
    // Call model
    const raw = await callOpenAI(messages);

    // Safety + polishing
    const want = pickCountByLength(payload?.length || 'medium');
    let captions = Array.isArray(raw.captions) ? raw.captions : [];
    let tags = Array.isArray(raw.hashtags) ? raw.hashtags : [];

    captions = uniq(captions.map(cleanCaption)).filter(Boolean).slice(0, want);
    // If model under-delivers, clone/trim to reach target count
    while (captions.length < want && captions.length > 0) {
      const cand = cleanCaption(captions[captions.length - 1]).replace(/\.$/, '');
      captions.push(cand);
    }
    if (captions.length === 0) {
      captions = ["Here’s the one change that unlocks better results."];
    }

    tags = curateHashtags(tags, {
      product: payload?.product || '',
      audience: payload?.audience || '',
      benefits: payload?.benefits || []
    });

    return res.status(200).json({ captions, hashtags: tags });
  } catch (err) {
    return res.status(500).json({
      error: 'OpenAI request failed',
      detail: String(err?.message || err)
    });
  }
}

// Read JSON safely (works on Vercel Node runtimes)
async function readJson(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  const text = await new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => data += c);
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
  try { return JSON.parse(text || '{}'); } catch { return {}; }
}
