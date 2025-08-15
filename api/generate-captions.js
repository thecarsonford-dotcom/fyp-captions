// api/generate-captions.js
// God-tier pipeline: n-best generation → heuristic filter → judge & polish → final JSON.

export const config = { runtime: 'edge' };

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const MODEL_GEN = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const MODEL_JUDGE = process.env.OPENAI_JUDGE_MODEL || 'gpt-4o-mini';

function J(res, status=200){ return new Response(JSON.stringify(res), {status, headers:{'content-type':'application/json'}}); }

function sysPrompt() {
  return `
You are "Caption Forge Pro" — a senior short-form copy chief.
Deliver *human* captions for TikTok/Reels/Shorts: hook-first, concrete benefit, natural micro-CTA (optional), then elite hashtags.

STYLE:
- Body 90–180 chars (not counting hashtags). Punchy & specific. 0–2 tasteful emoji max.
- No filler like "in this video", "check this out", "as an AI".
- Voice adapts to tone (bold/friendly/luxury/scientific/contrarian).
- Product/brand may appear once, naturally.

HASHTAGS:
- 12–16 total, lowercase, no spaces, no emojis, no repeats.
- Blend: 3–5 core niche, 5–8 long-tail/search intent, 1–3 broad discovery.
- Add at end of the combined line.

OUTPUT JSON ONLY (one object per candidate):
{
  "combined": "<one-line body + hashtags>",
  "body": "<caption body only, no hashtags>",
  "tags": ["tag1","tag2", ...] // no # symbols
}
`;
}

function userPrompt(ctx){
  const { product, audience, benefits=[], pains=[], tone='auto', length='medium', platform='tiktok' } = ctx;
  return `
PRODUCT: ${product||'unknown'}
AUDIENCE: ${audience||'general'}
BENEFITS: ${benefits.filter(Boolean).join(', ')||'unspecified'}
PAINS: ${pains.filter(Boolean).join(', ')||'unspecified'}
TONE: ${tone}
LENGTH: ${length}
PLATFORM: ${platform}

Return 6 JSON objects separated by \n---\n (no prose). Each follows the schema exactly.
`;
}

function judgePrompt(candidates, ctx){
  const { product, audience } = ctx;
  const pack = candidates.map((c,i)=>`#${i+1}\nBODY: ${c.body}\nTAGS: ${c.tags.map(t=>('#'+t)).join(' ')}`).join('\n\n');
  return `
You are the "Caption Forge" judge/polisher.

Goal: pick the SINGLE best caption that feels human and scroll-stopping *for ${product||'the product'}*, audience: *${audience||'general'}*.
Scoring (0–10 each): Human vibe, Hook strength, Benefit clarity/specificity, Audience fit, Hashtag completeness/relevance (12–16, niche+long-tail+broad).

Steps:
1) Score each candidate briefly.
2) Select the best one.
3) If it benefits from a tiny polish, apply a **light edit only** (keep message, keep length band, preserve emoji discipline).
4) Return JSON ONLY:
{
  "winnerIndex": <0-based>,
  "polished": {
    "combined": "<final one-line>",
    "body": "<body only>",
    "tags": ["tag1", "..."] // no #
  }
}

Candidates:
${pack}
`;
}

function parseNBests(blockText){
  // Split by --- and JSON-parse each chunk safely
  const chunks = String(blockText||'').split(/\n---\n/g);
  const out = [];
  for (const raw of chunks){
    try{
      const jsonStr = raw.slice(raw.indexOf('{'));
      const obj = JSON.parse(jsonStr);
      if (!obj || typeof obj !== 'object') continue;
      const body = String(obj.body||'').trim();
      const combined = String(obj.combined||'').trim();
      const tags = Array.isArray(obj.tags) ? obj.tags.map(t=>String(t||'').toLowerCase().replace(/^#/,'')).filter(Boolean) : [];
      if (combined && body && tags.length) out.push({ combined, body, tags });
    }catch{ /* ignore */ }
  }
  return out;
}

function badPhrasesScore(s){
  const t = s.toLowerCase();
  let p=0;
  if (/\b(check this out|in this video|as an ai|click the link)\b/.test(t)) p+=2;
  if (t.split('🧠').length-1 > 1) p+=1;
  return p;
}
function emojiCount(s){ return (s.match(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu)||[]).length; }

function heuristicFilter(cands){
  // Keep those with good length, low emoji, no banned phrases, tags size 12–16
  const keep = [];
  for (const c of cands){
    const body = c.body.trim();
    const len = body.length;
    const em = emojiCount(body);
    const bad = badPhrasesScore(body);
    const tagOk = c.tags.length>=12 && c.tags.length<=16;
    if (len>=90 && len<=220 && em<=2 && bad===0 && tagOk) keep.push(c);
  }
  // Fallback: if all filtered out, return originals
  return keep.length ? keep : cands;
}

async function openaiChat(model, messages, extra={}){
  const res = await fetch('https://api.openai.com/v1/chat/completions',{
    method:'POST',
    headers:{'authorization':`Bearer ${OPENAI_API_KEY}`, 'content-type':'application/json'},
    body: JSON.stringify({
      model,
      temperature: extra.temperature ?? 0.85,
      top_p: extra.top_p ?? 0.95,
      presence_penalty: extra.presence_penalty ?? 0.2,
      frequency_penalty: extra.frequency_penalty ?? 0.3,
      messages,
      response_format: { type: 'json_object' in (extra||{}) ? extra.response_format : { type: 'json_object' } }, // ensure JSON where needed
    })
  });
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${await res.text()}`);
  return res.json();
}

export default async function handler(req){
  try{
    if (req.method !== 'POST') return J({error:'Use POST with JSON body.'},405);
    if (!OPENAI_API_KEY) return J({error:'Missing OPENAI_API_KEY env var'},500);

    const body = await req.json().catch(()=> ({}));
    const ctx = {
      product: body.product || '',
      audience: body.audience || '',
      benefits: Array.isArray(body.benefits)? body.benefits : [],
      pains: Array.isArray(body.pains)? body.pains : [],
      tone: body.tone || 'auto',
      length: body.length || 'medium',
      platform: body.platform || 'tiktok',
    };

    // 1) N-best generation in one shot
    const gen = await openaiChat(MODEL_GEN, [
      {role:'system', content: sysPrompt()},
      {role:'user', content: userPrompt(ctx)}
    ], { temperature: 0.9, top_p: 0.96 });

    // The model returned JSON? We asked for 6 JSON objects separated with ---,
    // but Chat Completions returns a single "content" string. Extract it:
    const content = gen?.choices?.[0]?.message?.content || '';
    const candidates = parseNBests(content);
    if (!candidates.length) return J({error:'No candidates produced'}, 500);

    // 2) Heuristic filter
    const filtered = heuristicFilter(candidates).slice(0,5);

    // 3) Judge & polish
    const judge = await openaiChat(MODEL_JUDGE, [
      {role:'system', content:'You are a concise, strict evaluator that returns JSON only.'},
      {role:'user', content: judgePrompt(filtered, ctx)}
    ], { temperature: 0.4, top_p: 0.9 });

    let jText = judge?.choices?.[0]?.message?.content || '{}';
    try{
      // Some models may accidentally wrap JSON with text; extract last {...}
      const m = jText.match(/\{[\s\S]*\}$/);
      if (m) jText = m[0];
    }catch{}
    const j = JSON.parse(jText);

    const winnerIdx = (typeof j.winnerIndex==='number' && filtered[j.winnerIndex]) ? j.winnerIndex : 0;
    const fromJudge = j.polished && j.polished.combined && Array.isArray(j.polished.tags);

    const winner = fromJudge
      ? {
          combined: String(j.polished.combined||'').trim(),
          body: String(j.polished.body||'').trim(),
          tags: (j.polished.tags||[]).map(t=>String(t||'').toLowerCase().replace(/^#/,''))
        }
      : filtered[winnerIdx];

    // Normalize final fields
    const hashtags = [...new Set((winner.tags||[]).map(t=>t.toLowerCase().replace(/^#/,'')).filter(Boolean))].slice(0,16);
    let combined = String(winner.combined||'').trim();
    if (!combined || !/#\w/.test(combined)){
      combined = `${winner.body} ${hashtags.map(t=>'#'+t).join(' ')}`.trim();
    }

    // Build alternatives (body only)
    const alts = filtered
      .map((c,i)=> ({ i, body: c.body }))
      .filter(x=> x.i !== winnerIdx)
      .map(x=> x.body)
      .slice(0,3);

    return J({
      combined,
      captions: [winner.body, ...alts].slice(0,4),
      hashtags,
      alts
    }, 200);

  }catch(err){
    return J({ error:'OpenAI request failed', detail: (err && (err.message||String(err))) || 'unknown' }, 500);
  }
}
