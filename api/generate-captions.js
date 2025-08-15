// /api/generate-captions.js
// POST /api/generate-captions
// Body: { product, audience, benefits[], pains[], tone, length, platform, count?, hashCount? }
// Returns: { combined: string, captions: string[], hashtags: string[], from: "openai"|"fallback" }

const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const MODEL = "gpt-4o-mini";          // fast + high quality
const OPENAI_TIMEOUT_MS = 8000;       // hard stop to prevent Vercel 504s
const MAX_TOKENS_BUDGET = 380;        // keep generations tight

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

function ok(obj){ return JSON.stringify(obj ?? {}); }
const asArr = v => Array.isArray(v) ? v : (v ? [v] : []);

module.exports = async (req, res) => {
  cors(res);

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method Not Allowed" });

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "Missing OPENAI_API_KEY" });

  try {
    // ------- read & clamp inputs -------
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

    // lower caps to keep latency in check (still plenty of variety)
    const N = Math.max(2, Math.min(6, Number(count) || 6));
    const HN = Math.max(6, Math.min(12, Number(hashCount) || 8));

    // ------- prompts (FaceTime voice, anti-brand speak) -------
    const system = `
You are "Caption Catalyst" for FYP Insights Pro — an expert TikTok creator.

VOICE (STRICT):
- Never speak as the brand. Do NOT use "our", "we", or imply you made/sell it.
- Either (A) personal-use framing: "I've been using…" / "I love how this…"
  or (B) observational framing: "This helps with…" / "Perfect if you…"
- FaceTime-with-a-friend energy: natural, specific, helpful. No salesy buzzwords.
- Hook first (human, scroll-stopping), then 1 specific benefit and/or 1 pain point, then crisp CTA.
- Keep it relatable. Avoid hype language and brand claims.

HASHTAGS:
- One line, lowercase, space-separated, ${HN} total.
- Mix broad (#fyp, #tiktokshop), mid-tier category, and niche/SEO for product+audience.

OUTPUT:
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
benefits: ${asArr(benefits).join("; ")}
pains: ${asArr(pains).join("; ")}
tone: ${tone} | length: ${length} | platform: ${platform}
alts: ${N} | hashtags: ${HN}

Sound like a real person, not a brand. Keep it tight, specific, and viral-worthy.
`.trim();

    // ------- call OpenAI with timeout -------
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort("timeout"), OPENAI_TIMEOUT_MS);

    let from = "openai";
    let data;
    try {
      const resp = await fetch(OPENAI_URL, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: MODEL,
          temperature: 0.85,
          top_p: 0.9,
          presence_penalty: 0.3,
          frequency_penalty: 0.25,
          max_tokens: MAX_TOKENS_BUDGET,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: system },
            { role: "user", content: user }
          ]
        })
      });
      clearTimeout(timer);

      if (!resp.ok) {
        const detail = await resp.text().catch(() => "");
        // fall back if OpenAI unhappy (429/500/etc.)
        from = "fallback";
        return res.status(200).send(ok(fallbackGenerate({ product, audience, benefits, pains, N, HN })));
      }

      data = await resp.json();
    } catch (err) {
      clearTimeout(timer);
      // timeout or network -> fallback
      from = "fallback";
      return res.status(200).send(ok(fallbackGenerate({ product, audience, benefits, pains, N, HN })));
    }

    // ------- parse & sanitize model output -------
    const content = data?.choices?.[0]?.message?.content || "{}";
    let parsed = {};
    try { parsed = JSON.parse(content); } catch {}

    let captions = Array.isArray(parsed.captions) ? parsed.captions.filter(Boolean) : [];
    if (captions.length > N) captions = captions.slice(0, N);

    let hashtags = Array.isArray(parsed.hashtags) ? parsed.hashtags.filter(Boolean) : [];
    if (hashtags.length > HN) hashtags = hashtags.slice(0, HN);

    let combined = typeof parsed.combined === "string" ? parsed.combined.trim() : "";
    if (!combined && captions.length) {
      const line = hashtags.join(" ").trim();
      combined = line ? `${captions[0]}\n${line}` : captions[0];
    }

    // if model somehow returned empty, still fall back
    if (!captions.length && !combined) {
      from = "fallback";
      return res.status(200).send(ok(fallbackGenerate({ product, audience, benefits, pains, N, HN })));
    }

    return res.status(200).send(ok({
      combined: combined || "",
      captions,
      hashtags,
      from
    }));

  } catch (err) {
    // final catch — still keep the UX smooth
    return res.status(200).send(ok({ combined: "", captions: [], hashtags: [], from: "error" }));
  }
};

// ----------------- Fallback (fast, human-ish) -----------------

function slug(s){ return String(s||"").toLowerCase().replace(/&/g,"and").replace(/[^a-z0-9 ]/g,"").replace(/\s+/g,""); }
function seedRand(seed) { let t=0; for(let i=0;i<seed.length;i++) t=(t*31+seed.charCodeAt(i))>>>0;
  return ()=>{ let r=t+=0x6D2B79F5; r=Math.imul(r^r>>>15,r|1); r^=r+Math.imul(r^r>>>7,r|61); return ((r^r>>>14)>>>0)/4294967296; }; }

const BROAD = ["fyp","tiktokshop","tiktokmademebuyit","viral"];
const MID   = ["review","beforeafter","unboxing","asmr"];
const CAT   = {
  beauty:["skincare","glowup","skinbarrier","acnetips"],
  skincare:["skincare","barrierrepair","dermtips"],
  kitchen:["kitchen","mealprep","kitchenhacks","homecooking"],
  cleaning:["cleantok","cleaningtips","deepclean","cleaninghacks"],
  gadgets:["gadgets","tech","techtok","setup"],
  home:["homedecor","organize","apartment"],
  fitness:["fitness","workout","fitnesstips","homeworkout"],
  fashion:["fashion","outfit","ootd","capsulewardrobe"],
  pets:["pettok","dogsoftiktok","catsoftiktok","petparents"]
};

function quickHashtags({product, audience, benefits, pains, HN}) {
  const terms = []
    .concat(String(product).split(/\W+/))
    .concat(String(audience).split(/\W+/))
    .concat(asArr(benefits))
    .concat(asArr(pains))
    .map(slug).filter(x=>x && x.length>2 && x.length<28);

  const niche = new Set(terms);
  terms.forEach(t=>{ if (t && Math.random()<0.35) niche.add(t + (Math.random()<0.5?'tips':'hack')); });

  function take(pool, n){ const out=[]; pool=[...pool]; for(let i=0;i<n && pool.length;i++){ out.push(pool.splice(Math.floor(Math.random()*pool.length),1)[0]); } return out; }

  const categoryGuess = (terms.includes("skin")||terms.includes("serum")) ? "skincare" :
                        (terms.includes("kitchen")||terms.includes("cook")) ? "kitchen" : "";
  const cat = CAT[categoryGuess] || [];

  const picks = []
    .concat(take(BROAD, Math.ceil(HN*0.3)))
    .concat(take(MID, Math.ceil(HN*0.25)))
    .concat(take(cat, Math.ceil(HN*0.2)))
    .concat(take([...niche], HN)); // over-pick then slice

  const uniq = []; const seen=new Set();
  for (const h of picks) {
    const w = slug(h); if (!w || seen.has(w)) continue;
    seen.add(w); uniq.push('#'+w);
    if (uniq.length>=HN) break;
  }
  return uniq.slice(0, HN);
}

function fallbackGenerate({ product, audience, benefits, pains, N, HN }) {
  const seed = `${product}|${audience}|${asArr(benefits).join(",")}|${asArr(pains).join(",")}|${new Date().toDateString()}`;
  const r = seedRand(seed);
  const pain = asArr(pains)[0] || "doing this the hard way";
  const benefit = asArr(benefits)[0] || "better results with less effort";

  const hooks = [
    `ok real talk — ${benefit}.`,
    `not me finally fixing ${pain}…`,
    `${benefit} with zero fuss.`,
    `if ${pain} is your life, watch this.`,
    `this is the shortcut to ${benefit}.`
  ];

  const ctas = [
    "tap for the receipts →",
    "save this for later.",
    "want the steps? tap through.",
    "sharing in case you need it too."
  ];

  function pick(arr){ return arr[Math.floor(r()*arr.length)]; }

  const caps = [];
  for (let i=0;i<N;i++){
    const prefix = pick(hooks);
    const mid = product ? ` ${product} just helped me get there.` : " this just helped me get there.";
    const end = " " + pick(ctas);
    const line = `${prefix}${mid} ${end}`.replace(/\s+/g,' ').trim();
    caps.push(line);
  }

  const tags = quickHashtags({ product, audience, benefits, pains, HN });
  return {
    from: "fallback",
    combined: `${caps[0]}\n${tags.join(" ")}`,
    captions: caps,
    hashtags: tags
  };
}
