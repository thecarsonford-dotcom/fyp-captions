// api/generate-captions.js
// Drop-in: produces paste-ready "combined" caption + hashtags, plus arrays for UI.

export const config = { runtime: 'edge' };

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const MODEL_PRIMARY = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const MODEL_FALLBACK = 'gpt-4o-mini';

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function buildSystemPrompt() {
  return `
You are "Caption Forge" — a senior direct-response copywriter for short-form video (TikTok/Reels/Shorts).
Your job: deliver a SINGLE, PASTE-READY caption that opens with a strong hook and ends with a perfectly curated hashtag set.

### STYLE RULES
- Hook first, value second, clear CTA third (where appropriate).
- Tight, conversational, audience-aware. 1–2 tasteful emojis max in the body. No emoji spam.
- Keep the **body** ~90–180 characters (not counting hashtags). Never ramble.
- Use concrete benefits and pains the user provides. If scarce, infer believable ones from niche context.
- Never sound “AI-ish”—no generic filler (“Check this out!”, “In this video,” etc.).
- Optional micro-CTA: “Tap to see”, “Full rundown in video”, “Save for later”, “Link in bio”, etc. Use sparingly.
- Brand names may appear once, naturally (no shilling).

### HASHTAG RULES
- Output 12–16 hashtags, lowercase, no spaces.
- Blend: 3–5 core niche tags, 5–8 long-tail/search intent tags, 1–3 broad discovery tags.
- Never repeat. Keep platform-safe (no banned words). No emojis in hashtags.
- Place hashtags **at the end** of the combined caption.

### OUTPUT FORMAT (JSON only)
{
  "combined": "<one-line caption ending with hashtags>",
  "captions": ["<body-only variant 1>", "<variant 2>", "<variant 3>"],
  "hashtags": ["tag1","tag2","tag3", "... (no # symbols here)"]
}

If information is missing, make the best reasonable assumptions for the niche.
`;
}

function buildUserPrompt({ product, audience, benefits, pains, tone, length, platform }) {
  const b = (benefits || []).filter(Boolean);
  const p = (pains || []).filter(Boolean);
  return `
PRODUCT: ${product || 'Unknown'}
AUDIENCE: ${audience || 'general'}
BENEFITS: ${b.length ? b.join(', ') : 'not specified'}
PAINS: ${p.length ? p.join(', ') : 'not specified'}
TONE: ${tone || 'auto'}
LENGTH: ${length || 'medium'}
PLATFORM: ${platform || 'tiktok'}

Return JSON only, per schema.`;
}

function fewShotMessages() {
  return [
    {
      role: 'user',
      content: `PRODUCT: VEVOR chicken coop
AUDIENCE: chicken owners, backyard poultry
BENEFITS: affordable, sturdy, easy setup
PAINS: coops are expensive, budget tight
TONE: bold
LENGTH: medium
PLATFORM: tiktok

Return JSON only.`,
    },
    {
      role: 'assistant',
      content: JSON.stringify({
        combined:
          'Finally an affordable coop 🐔✨ Happy hens without wrecking your budget — sturdy, easy setup, done. Tap for details ↓ #chickencoop #backyardchickens #affordablecoop #chickenkeeping #homesteading #raisingchickens #backyardfarm #cooplife #vevor #vevoreview #urbanfarming #chickenlife #chickenlover #backyardpoultry #budgetfriendly',
        captions: [
          'Affordable coop that keeps hens happy — sturdy build, easy setup, no budget stress.',
          'Stop overpaying for coops. This one’s sturdy, simple, and actually affordable.',
          'Built to last, priced to chill. Backyard-ready in a snap — hens approve.',
        ],
        hashtags: [
          'chickencoop','backyardchickens','affordablecoop','chickenkeeping','homesteading',
          'raisingchickens','backyardfarm','cooplife','vevor','vevoreview','urbanfarming',
          'chickenlife','chickenlover','backyardpoultry','budgetfriendly'
        ],
      }),
    },

    // A second quick shot for style shaping (beauty)
    {
      role: 'user',
      content: `PRODUCT: Ceramide barrier serum
AUDIENCE: oily/sensitive skin
BENEFITS: barrier repair, makeup holds, calmer skin in a week
PAINS: redness, breakouts, makeup separating
TONE: friendly
LENGTH: short
PLATFORM: tiktok

Return JSON only.`,
    },
    {
      role: 'assistant',
      content: JSON.stringify({
        combined:
          'Fix the barrier, fix the chaos ✨ Calm redness, fewer breakouts, makeup that actually stays. Save this for later ↓ #ceramide #skinbarrier #barrierrepair #oilyskin #sensitiveskin #dermskincare #acneprone #glassskin #skinroutine #skincaretips #hydration #noncomedogenic #skinsos #makeuplock #sebumcontrol',
        captions: [
          'Calmer skin in a week: barrier first, everything else gets easier.',
          'When makeup slides, it’s the barrier. Repair it and watch the glow stick.',
          'Redness down, balance up — small change, big win.',
        ],
        hashtags: [
          'ceramide','skinbarrier','barrierrepair','oilyskin','sensitiveskin',
          'dermskincare','acneprone','glassskin','skinroutine','skincaretips',
          'hydration','noncomedogenic','skinsos','makeuplock','sebumcontrol'
        ],
      }),
    },
  ];
}

async function callOpenAI(messages) {
  const body = {
    model: MODEL_PRIMARY,
    temperature: 0.85,
    top_p: 0.95,
    presence_penalty: 0.2,
    frequency_penalty: 0.3,
    messages,
    response_format: { type: 'json_object' },
  };

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${OPENAI_API_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`OpenAI ${res.status}: ${txt || res.statusText}`);
  }
  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content || '{}';
  return content;
}

function safeParseJSON(s) {
  try {
    // extract first {...} block if extra text sneaks in
    const match = s.match(/\{[\s\S]*\}$/);
    const json = match ? match[0] : s;
    const obj = JSON.parse(json);
    return obj && typeof obj === 'object' ? obj : {};
  } catch {
    return {};
  }
}

function dedupeTags(arr) {
  const seen = new Set();
  const out = [];
  for (const t of arr || []) {
    const v = (t || '').toString().trim().toLowerCase().replace(/^#/, '');
    if (!v || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

export default async function handler(req) {
  try {
    if (req.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'access-control-allow-origin': '*',
          'access-control-allow-methods': 'POST, OPTIONS',
          'access-control-allow-headers': 'content-type, authorization',
        },
      });
    }

    if (req.method !== 'POST') {
      return jsonResponse({ error: 'Use POST with JSON body.' }, 405);
    }

    if (!OPENAI_API_KEY) {
      return jsonResponse({ error: 'Missing OPENAI_API_KEY env var' }, 500);
    }

    const { product, audience, benefits, pains, tone, length, platform } =
      await req.json().catch(() => ({}));

    const sys = buildSystemPrompt();
    const user = buildUserPrompt({
      product,
      audience,
      benefits,
      pains,
      tone,
      length,
      platform,
    });

    const messages = [
      { role: 'system', content: sys },
      ...fewShotMessages(),
      { role: 'user', content: user },
    ];

    let content;
    try {
      content = await callOpenAI(messages);
    } catch (e) {
      // Fallback model (in case you later swap primary to a larger model)
      if (MODEL_PRIMARY !== MODEL_FALLBACK) {
        content = await callOpenAI([{ role: 'system', content: sys }, ...fewShotMessages(), { role: 'user', content: user }]);
      } else {
        throw e;
      }
    }

    const parsed = safeParseJSON(content);

    // Normalize output
    const captions = Array.isArray(parsed.captions) ? parsed.captions.slice(0, 5) : [];
    const hashtags = dedupeTags(parsed.hashtags).slice(0, 16);
    let combined = (parsed.combined || '').toString().trim();

    // If missing combined, synthesize it
    if (!combined) {
      const body = captions[0] || 'Here’s the gist.';
      const tagLine = hashtags.length ? ' ' + hashtags.map(t => '#' + t).join(' ') : '';
      combined = body + tagLine;
    }

    return jsonResponse({ combined, captions, hashtags }, 200);
  } catch (err) {
    return jsonResponse(
      {
        error: 'OpenAI request failed',
        detail: (err && (err.message || String(err))) || 'unknown',
      },
      500
    );
  }
}
