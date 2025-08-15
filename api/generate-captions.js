// /api/generate-captions.js
export const config = { runtime: 'nodejs18.x' };

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_BASE = process.env.OPENAI_API_BASE || 'https://api.openai.com/v1';
const MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const ANCHOR_TAG = (process.env.ANCHOR_TAG || '').trim().toLowerCase(); // e.g. "fypinsights" or leave blank

const BANNED_TAGS = new Set([
  'followforfollow','f4f','likeforlike','l4l','followback','sub4sub',
  'viraltiktok','viralvideo','foru','fypシ','fyppppppp','nudity','nsfw','adult','xxx'
]);

function uniq(arr) {
  const out = [], seen = new Set();
  for (const s of arr || []) {
    const k = (s||'').trim().toLowerCase();
    if (!k || seen.has(k)) continue;
    seen.add(k); out.push(s.trim());
  }
  return out;
}
function clamp(s, n=220) { return (s||'').length > n ? (s||'').slice(0,n-1) : (s||''); }
function cleanCaption(s) {
  let t = (s||'').trim()
    .replace(/\s+/g,' ')
    .replace(/\s([?!.,:;])/g,'$1')
    .replace(/[“”]/g,'"').replace(/[‘’]/g,"'")
    .replace(/\.+$/,'').trim();
  // keep ~140–220 chars; encourage bold open
  if (t.length > 230) t = clamp(t, 220);
  return t;
}
function cleanTag(s) {
  let t = (s||'').toLowerCase().replace(/[^a-z0-9]+/g,'');
  if (!t || BANNED_TAGS.has(t)) return '';
  return t;
}
function curateHashtags(seedTags, { product, audience, benefits }) {
  let cleaned = uniq((seedTags||[]).map(cleanTag)).filter(Boolean);

  const broadSeeds = [
    'tiktokshop','creator','smallbusiness','ecommerce','onlineshop','marketing','shortform'
  ];
  const fromInputs = uniq([
    ...(product||'').toLowerCase().split(/\s+/).slice(0,3),
    ...(audience||'').toLowerCase().split(/\s*;\s*/),
    ...((benefits||[]).flatMap(b => b.toLowerCase().split(/\s+/).slice(0,2)))
  ]).map(cleanTag).filter(Boolean);

  const broad = uniq(broadSeeds.map(cleanTag)).slice(0,6);
  const niche = uniq([...fromInputs, ...cleaned]).slice(0,16);

  // Compose 12–18 tags: ~4 broad + ~7–9 niche + ~2–3 long-tail (from benefits squashed)
  const longTail = uniq((benefits||[]).map(b => cleanTag(b.replace(/\s+/g,'')))).slice(0,6);

  let out = uniq([
    ...broad.slice(0, 4 + Math.floor(Math.random()*2)),     // 4–5
    ...niche.slice(0, 7 + Math.floor(Math.random()*3)),      // 7–9
    ...longTail.slice(0, 2 + Math.floor(Math.random()*2)),   // 2–3
  ]).filter(Boolean);

  if (ANCHOR_TAG && !out.includes(ANCHOR_TAG)) out.unshift(ANCHOR_TAG);
  if (out.length < 12) for (const t of cleaned) { if (!out.includes(t)) out.push(t); if (out.length>=12) break; }
  if (out.length > 18) out = out.slice(0,18);

  return out;
}

function buildMessages(p) {
  const {
    product = '', audience = '', benefits = [], pains = [],
    tone = 'Bold', length = 'medium', platform = 'tiktok'
  } = p || {};

  const system = `
You are CAPTION-FORGE, an elite short-form copywriter for TikTok/Reels/Shorts.
Return STRICT JSON with keys: "caption" (string) and "hashtags" (array of strings w/o "#").

Rules:
- Output ONE caption only, post-ready.
- Lead with a punchy hook (4–14 words), then 1–2 concrete payoffs.
- Natural tone; no fluff, no keyword stuffing, no “link in bio”, no “follow for more”.
- Emojis: optional, max 2 total, used tastefully (not repeated).
- Honor tone="${tone}" subtly; platform="${platform}" vibe.
- Length="${length}" → concise but complete (≈ 80–180 chars).
- Hashtags: 12–18, mix of broad/niche/long-tail, no banned tags, no "#".
- If brand anchor "${ANCHOR_TAG}" is non-empty, include it exactly once.
`;

  const fewShotUser = `
Product: VEVOR Chicken Coop
Audience: chicken owners
Benefits: affordable; sturdy; easy to assemble
Pains: coops are expensive; flimsy builds
Tone: Bold
Length: medium
Platform: TikTok
Return JSON only.
`;
  const fewShotAssistant = JSON.stringify({
    caption: "Finally, a coop that doesn’t wreck your budget. Sturdy build, easy setup—happy hens, happier wallet. 🐔",
    hashtags: [
      "fypinsights","chickencoop","backyardchickens","homesteading","chickenkeeping",
      "cooplife","urbanfarming","backyardpoultry","budgetfriendly","vevor","vevoreview",
      "chickenowners","diycoop","henhouse","farmtok"
    ]
  });

  const userBrief = `
Product: ${product}
Audience: ${audience}
Benefits: ${(benefits||[]).join('; ')}
Pains: ${(pains||[]).join('; ')}
Tone: ${tone}
Length: ${length}
Platform: ${platform}
Return JSON only.
`;

  return [
    { role: 'system', content: system.trim() },
    { role: 'user', content: fewShotUser.trim() },
    { role: 'assistant', content: fewShotAssistant },
    { role: 'user', content: userBrief.trim() }
  ];
}

async function callOpenAI(messages) {
  const res = await fetch(`${OPENAI_BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      messages,
      temperature: 0.72,
      top_p: 0.95,
      presence_penalty: 0.2,
      frequency_penalty: 0.15,
      response_format: { type: 'json_object' }
    })
  });
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${await res.text().catch(()=>res.statusText)}`);
  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content || '{}';
  return JSON.parse(content);
}

function buildCombined(caption, tags) {
  const tagLine = tags.map(t => `#${t}`).join(' ');
  return `${caption} ${tagLine}`.trim();
}

async function readJson(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  const text = await new Promise((resolve, reject)=>{
    let s=''; req.on('data',c=>s+=c); req.on('end',()=>resolve(s)); req.on('error',reject);
  });
  try { return JSON.parse(text||'{}'); } catch { return {}; }
}

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    if (!OPENAI_API_KEY) return res.status(500).json({ error: 'Missing OPENAI_API_KEY' });

    const payload = await readJson(req);
    const msg = buildMessages(payload);
    const raw = await callOpenAI(msg);

    let caption = cleanCaption(raw.caption || '');
    let tags = curateHashtags(raw.hashtags || [], {
      product: payload.product, audience: payload.audience, benefits: payload.benefits
    });

    if (!caption) caption = "Here’s the upgrade your feed actually needs.";
    const combined = buildCombined(caption, tags);

    // Keep older client shape compatible
    return res.status(200).json({
      caption,
      captions: [combined],      // your page can show this as the single item
      hashtags: tags,
      combined                    // explicit combined for convenience
    });
  } catch (e) {
    return res.status(500).json({ error: 'OpenAI request failed', detail: String(e?.message||e) });
  }
}
