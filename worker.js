// Hayy: a taste-grounded marketing agent for small cafés and restaurants.
// POST /api/brief    → agent loop (LLM + Qloo tools) → JSON brief + call trace
// POST /api/baseline → same question, LLM only (for the side-by-side)
const QLOO = 'https://hackathon.api.qloo.com';

const TOOLS = [
  {
    name: 'qloo_search',
    description: 'Find Qloo entities (venues, artists, brands, films…) by name. Use it to get the entity id of the owner\'s venue or of things you want to use as taste signals.',
    parameters: { type: 'object', properties: {
      query: { type: 'string' },
      types: { type: 'string', description: 'Comma-separated entity URNs, e.g. urn:entity:place' },
    }, required: ['query'] },
  },
  {
    name: 'qloo_insights',
    description: 'Ask Qloo what an audience likes. Signal with entity ids (people who like X) and/or a location; get back entities of filter_type ranked by affinity.',
    parameters: { type: 'object', properties: {
      filter_type: { type: 'string', enum: ['urn:entity:artist', 'urn:entity:brand', 'urn:entity:movie', 'urn:entity:tv_show', 'urn:entity:place', 'urn:entity:book', 'urn:entity:podcast', 'urn:entity:destination', 'urn:entity:person', 'urn:entity:video_game'] },
      interest_entities: { type: 'string', description: 'Comma-separated Qloo entity ids used as the taste signal' },
      location: { type: 'string', description: 'Neighborhood/city name or WKT POINT. ONLY use with filter_type urn:entity:place — combining it with artist/brand/movie/tv_show returns zero results.' },
      filter_location: { type: 'string', description: 'Only return places inside this neighborhood/city (places only)' },
      filter_tags: { type: 'string', description: 'Comma-separated Qloo tag ids to narrow results' },
      take: { type: 'integer' },
    }, required: ['filter_type'] },
  },
  {
    name: 'qloo_tags',
    description: 'Find Qloo tag ids (cuisines, genres, styles) by keyword.',
    parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  },
];

async function qloo(env, path, params) {
  const u = new URL(QLOO + path);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') u.searchParams.set(k, v);
  const r = await fetch(u, { headers: { 'X-Api-Key': env.QLOO_KEY } });
  const body = await r.json().catch(() => ({ error: r.statusText }));
  return { status: r.status, url: u.pathname + u.search, body };
}

// Keep tool results small: the model only needs names, affinity, a few tags. This is the main lever on
// how many briefs a free tier can serve in a day — the loop re-sends the whole transcript every call,
// so trimming each result compounds across ~8 calls. Rounding affinity also stops the model echoing
// 17-digit floats into the evidence list.
const round2 = n => (typeof n === 'number' ? Math.round(n * 100) / 100 : undefined);
const slim = list => (list || []).slice(0, 8).map(e => ({
  id: e.entity_id, name: e.name, type: e.subtype || e.types?.[0],
  affinity: round2(e.query?.affinity ?? e.affinity), popularity: round2(e.popularity),
  tags: (e.tags || []).slice(0, 3).map(t => t.name),
}));

const RUN = {
  qloo_search: (env, a) => qloo(env, '/search', { query: a.query, types: a.types, take: 5 }),
  qloo_insights: (env, a) => qloo(env, '/v2/insights', {
    'filter.type': a.filter_type,
    'signal.interests.entities': a.interest_entities,
    'signal.location.query': a.location,
    'filter.location.query': a.filter_location,
    'filter.tags': a.filter_tags,
    take: a.take || 10,
  }),
  qloo_tags: (env, a) => qloo(env, '/v2/tags', { 'filter.query': a.query, take: 10 }),
};

// Every free LLM tier runs out: Workers AI caps a day at 10,000 neurons, Gemini's free tier at 20
// requests. One provider therefore cannot keep a public demo up, so configure several and fall through
// to the next when one is exhausted. Provider 1 is whatever LLM_* says; add LLM_*2 for a backup.
const providers = env => ['', '2', '3', '4']
  .map(n => ({ base: env['LLM_BASE' + n], model: env['LLM_MODEL' + n], key: env['LLM_KEY' + n],
               // Routing Workers AI through an AI Gateway is just a header, and it is what enforces the
               // spend cap: past the budget the gateway refuses the call and the chain falls through.
               gateway: env['LLM_GATEWAY' + n] }))
  .filter(p => p.base && p.key && p.model);

// Only things that mean "come back tomorrow". Deliberately NOT matching Groq's per-minute message,
// which also says "upgrade"/"billing" but clears in under a minute and is worth waiting out.
const EXHAUSTED = /daily free allocation|neurons|exceeded your current quota|RESOURCE_EXHAUSTED|requires more credit|requests per day|RPD|budget|spend limit|AiGatewayError/i;

async function callProvider(p, messages, tools) {
  const body = JSON.stringify({
    model: p.model, messages, temperature: 0.4,
    // Must be explicit: Workers AI caps completions at a couple of hundred tokens by default, which
    // truncated the brief mid-playlist and looked like malformed JSON rather than a length limit.
    max_tokens: 4096,
    ...(tools && { tools: tools.map(f => ({ type: 'function', function: f })) }),
  });
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(p.base + '/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer ' + p.key,
        ...(p.gateway && { 'cf-aig-gateway-id': p.gateway }),
      },
      body,
    });
    const text = await r.text();
    // A quota that resets tomorrow is not worth retrying — hand straight to the next provider.
    if (EXHAUSTED.test(text)) { const e = new Error('exhausted: ' + text.slice(0, 200)); e.exhausted = true; throw e; }
    // 429 = rate limit, 5xx = the model is briefly overloaded; both are routine and both are worth waiting out.
    if (r.status === 429 || r.status >= 500) {
      // Cap the wait: a judge staring at a spinner is worse than an honest "try again in a minute".
      if (attempt < 3) {
        const hint = +(text.match(/try again in ([\d.]+)s/)?.[1] || 0);
        // Honour the provider's own hint up to 20s; past that another provider beats waiting.
        await new Promise(res => setTimeout(res, Math.min(20, hint || 2 ** attempt * 3) * 1000 + 500));
        continue;
      }
      // Still limited after backing off: another provider is likelier to answer than more waiting.
      const e = new Error('rate-limited: ' + text.slice(0, 160)); e.exhausted = true; throw e;
    }
    const j = JSON.parse(text || '{}');
    if (!j.choices) throw new Error('LLM: ' + text.slice(0, 300));
    return j.choices[0].message;
  }
}

// A spent provider stays spent for a while, so remember it rather than rediscovering it on every one of
// the ~8 calls a brief makes. Without this, falling through to the saved run took over a minute — long
// enough that a visitor gives up before seeing anything.
// ponytail: per-isolate and time-based, no coordination; the cost of being wrong is one wasted attempt.
const spent = new Map();
const SPENT_MS = 10 * 60 * 1000;

async function llm(env, messages, tools) {
  const ps = providers(env);
  if (!ps.length) throw new Error('No LLM provider configured.');
  const now = Date.now();
  const fresh = ps.filter(p => !(spent.get(p.base) > now));
  let last;
  for (const p of (fresh.length ? fresh : ps)) {
    try { return await callProvider(p, messages, tools); }
    catch (e) {
      last = e;
      if (!e.exhausted) throw e;   // a real failure belongs to the caller; only exhaustion falls through
      spent.set(p.base, Date.now() + SPENT_MS);
    }
  }
  const e = new Error('All configured LLM providers are out of quota for today.');
  e.exhausted = true; e.cause = last; throw e;
}

const BRIEF_SHAPE = `Return ONLY JSON:
{"audience":"2-3 sentences on who is around this venue and what they love",
 "menu":[{"idea":"…","why":"…"}],
 "playlist":[{"artist":"…","why":"…"}],
 "collabs":[{"brand":"…","idea":"…"}],
 "posts":[{"day":"Sun","ar":"Arabic post","en":"English post"}],
 "evidence":["each claim above → the Qloo entity/affinity it rests on"]}
3 menu ideas, 6 artists, 3 collabs, 5 posts (Sun–Thu). Saudi audience: Arabic posts in natural Saudi tone, no alcohol, no pork.

Be specific or you have failed:
- "idea" is ONE named item a customer could order, specific enough to print on a menu board:
  a flavour or ingredient plus a format. Never a category like "specialty coffee drinks",
  "healthy options" or "vegetarian meals". Derive it from the tags and entities Qloo actually
  returned for THIS venue — do not reuse any example wording from these instructions. It must be
  something this venue would plausibly serve given its concept: a coffee roastery sells drinks and
  things to eat beside them, not a main course.
- "why" names the Qloo entity or tag that justifies it and what it implies, in one concrete sentence.
- "collabs" name a real brand or venue that came back from Qloo, plus a specific thing to do together.
- Every "evidence" line must name the real Qloo entity you received — its NAME, never its id/UUID —
  and its affinity or popularity number rounded to two decimals, then an arrow, then which recommendation above it supports. Keep it
  to one line. Never write "as shown by the qloo_insights output" — that says nothing.
- Posts are written for customers, not about the data: give an actual caption someone would post.`;

const ask = b => `Venue: ${b.venue}\nArea: ${b.area}\nConcept: ${b.concept || 'not given'}`;

async function brief(env, b) {
  const trace = [];
  const messages = [
    { role: 'system', content: `You are Hayy, a marketing strategist for small cafés and restaurants. Every recommendation must rest on Qloo taste data you fetched, never on general knowledge. Plan: 1) qloo_search the venue (types urn:entity:place); 2) use its id as interest_entities to pull what this audience likes: artists, brands, films/TV; 3) look up tags if you need a cuisine/genre. If the venue is not in Qloo, search 1-2 similar well-known places in the same area and use their ids as the signal. Rules learned from the API: pass location ONLY when filter_type is urn:entity:place — with artist/brand/movie it returns zero results, so signal taste with interest_entities instead. If a call returns an error or empty results, change the arguments; never repeat an identical call. Use at most 8 tool calls.\n${BRIEF_SHAPE}` },
    { role: 'user', content: ask(b) },
  ];
  for (let step = 0; step < 10; step++) {
    // Some models wrap the final answer in a bogus tool call, which the gateway rejects outright.
    // Retrying the same step with no tools forces the answer into content instead of losing the run.
    let m;
    try {
      m = await llm(env, messages, step < 9 ? TOOLS : undefined);
    } catch (e) {
      if (!/tool_use_failed|[Tt]ool call validation/.test(String(e.message))) throw e;
      m = await llm(env, messages, undefined);
    }
    // Normalise the assistant turn before echoing it back. Workers AI returns `content: null` beside
    // tool_calls and then rejects null on the next request (its error claims a type mismatch on every
    // message, which is misleading — only this field is wrong). Array content gets flattened for the
    // shims that return parts.
    if (Array.isArray(m.content)) m.content = m.content.map(p => p?.text ?? '').join('');
    else if (m.content == null) m.content = '';
    messages.push(m);
    if (!m.tool_calls?.length) {
      if (!trace.some(t => t.status === 200 && t.n)) throw new Error('Qloo returned no taste data for this venue/area, so there is nothing grounded to say.');
      let brief = parse(m.content);
      // Smaller models sometimes end with prose around the JSON, or stop mid-object. One corrective
      // turn recovers the brief far more often than it costs, and the Qloo work is already paid for.
      if (brief.raw) {
        messages.push({ role: 'user', content: 'That was not a complete, valid JSON object. Reply with ONLY the JSON object described earlier — no prose, no code fences, every field present and the braces closed.' });
        const retry = parse((await llm(env, messages, undefined)).content);
        if (!retry.raw) brief = retry;
      }
      return { brief, trace };
    }
    for (const c of m.tool_calls) {
      const args = JSON.parse(c.function.arguments || '{}');
      const res = await RUN[c.function.name]?.(env, args) ?? { status: 400, body: { error: 'unknown tool' } };
      const out = res.body?.results?.entities ?? res.body?.results?.tags ?? res.body?.results ?? res.body;
      const data = Array.isArray(out) ? slim(out) : out;
      trace.push({ tool: c.function.name, args, status: res.status, url: res.url, n: Array.isArray(out) ? out.length : undefined, top: Array.isArray(data) ? data.slice(0, 5) : undefined });
      messages.push({ role: 'tool', tool_call_id: c.id, content: JSON.stringify(data).slice(0, 2500) });
    }
  }
  throw new Error('agent did not finish');
}

async function baseline(env, b) {
  const m = await llm(env, [
    { role: 'system', content: 'You are a marketing strategist for small cafés and restaurants.\n' + BRIEF_SHAPE },
    { role: 'user', content: ask(b) },
  ]);
  return { brief: parse(m.content) };
}

function parse(s) {
  const t = (s || '').replace(/^```(json)?|```$/gm, '').trim();
  try { return JSON.parse(t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1)); } catch { return { raw: s }; }
}

// The demo is public and each brief costs real LLM tokens, so cap how fast one caller can spend them.
// ponytail: per-isolate counters, so the limit is per edge location rather than global. Good enough to
// stop a loop or a scraper; move to Durable Objects if a real flood ever shows up.
const SEEN = new Map();
const PER_IP = 6, WINDOW_MS = 10 * 60 * 1000;
function overLimit(req) {
  const ip = req.headers.get('CF-Connecting-IP') || 'local';
  const now = Date.now();
  const hits = (SEEN.get(ip) || []).filter(t => now - t < WINDOW_MS);
  if (hits.length >= PER_IP) return true;
  hits.push(now);
  SEEN.set(ip, hits);
  if (SEEN.size > 5000) for (const [k, v] of SEEN) if (!v.some(t => now - t < WINDOW_MS)) SEEN.delete(k);
  return false;
}

// When every provider is out of quota, fall back to a real saved run rather than an error page, and
// label it as saved. These are genuine responses captured from this same code, not hand-written.
const slug = b => `${b.venue} ${b.area}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);

async function savedRun(req, env, b) {
  const r = await env.ASSETS.fetch(new URL(`/saved/${slug(b)}.json`, req.url));
  if (!r.ok) return null;
  const j = await r.json().catch(() => null);
  return j && { ...j, cached: true };
}

export default {
  async fetch(req, env) {
    const { pathname } = new URL(req.url);
    if (req.method === 'POST' && (pathname === '/api/brief' || pathname === '/api/baseline')) {
      if (overLimit(req))
        return Response.json({ error: `Rate limit: ${PER_IP} briefs per 10 minutes per visitor. This is a hackathon demo on a personal API key — thanks for understanding.` }, { status: 429 });
      const b = await req.json().catch(() => ({}));
      if (!b.venue || !b.area || b.venue.length > 120 || b.area.length > 120 || (b.concept || '').length > 300)
        return Response.json({ error: 'venue and area are required (short text)' }, { status: 400 });
      try {
        return Response.json(await (pathname === '/api/brief' ? brief : baseline)(env, b));
      } catch (e) {
        const msg = String(e.message || e);
        if (e.exhausted) {
          const saved = await savedRun(req, env, b).catch(() => null);
          if (saved) return Response.json(saved);
        }
        // The demo runs on a free LLM tier with a per-minute cap. Say so plainly instead of showing
        // a judge a raw provider payload.
        if (/quota|RESOURCE_EXHAUSTED|\b429\b/.test(msg))
          return Response.json({ error: 'The free LLM tier behind this demo hit its per-minute quota. Give it a minute and try again — it resets quickly.' }, { status: 429 });
        if (/UNAVAILABLE|high demand|\b50[0-9]\b/.test(msg))
          return Response.json({ error: 'The model is briefly overloaded. Try again in a moment.' }, { status: 503 });
        return Response.json({ error: msg }, { status: 502 });
      }
    }
    return env.ASSETS.fetch(req);
  },
};
