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

// Keep tool results small: the model only needs names, ids, affinity, a few tags.
const slim = list => (list || []).slice(0, 12).map(e => ({
  id: e.entity_id, name: e.name, type: e.subtype || e.types?.[0],
  affinity: e.query?.affinity ?? e.affinity, popularity: e.popularity,
  tags: (e.tags || []).slice(0, 5).map(t => t.name),
  address: e.properties?.address,
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

async function llm(env, messages, tools) {
  const body = JSON.stringify({
    model: env.LLM_MODEL, messages, temperature: 0.4,
    ...(tools && { tools: tools.map(f => ({ type: 'function', function: f })) }),
  });
  // Free tiers rate-limit per minute and overload intermittently; a brief is ~10 calls, so one bad
  // response must not lose the whole run.
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(env.LLM_BASE + '/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + env.LLM_KEY },
      body,
    });
    const text = await r.text();
    // 429 = rate limit, 5xx = the model is briefly overloaded; both are routine and both are worth waiting out.
    if ((r.status === 429 || r.status >= 500) && attempt < 4) {
      const hint = +(text.match(/try again in ([\d.]+)s/)?.[1] || 0);
      await new Promise(res => setTimeout(res, Math.min(60, hint || 2 ** attempt * 5) * 1000 + 500));
      continue;
    }
    const j = JSON.parse(text || '{}');
    if (!j.choices) throw new Error('LLM: ' + text.slice(0, 300));
    return j.choices[0].message;
  }
}

const BRIEF_SHAPE = `Return ONLY JSON:
{"audience":"2-3 sentences on who is around this venue and what they love",
 "menu":[{"idea":"…","why":"…"}],
 "playlist":[{"artist":"…","why":"…"}],
 "collabs":[{"brand":"…","idea":"…"}],
 "posts":[{"day":"Sun","ar":"Arabic post","en":"English post"}],
 "evidence":["each claim above → the Qloo entity/affinity it rests on"]}
3 menu ideas, 6 artists, 3 collabs, 5 posts (Sun–Thu). Saudi audience: Arabic posts in natural Saudi tone, no alcohol, no pork.`;

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
    messages.push(m);
    if (!m.tool_calls?.length) {
      if (!trace.some(t => t.status === 200 && t.n)) throw new Error('Qloo returned no taste data for this venue/area, so there is nothing grounded to say.');
      return { brief: parse(m.content), trace };
    }
    for (const c of m.tool_calls) {
      const args = JSON.parse(c.function.arguments || '{}');
      const res = await RUN[c.function.name]?.(env, args) ?? { status: 400, body: { error: 'unknown tool' } };
      const out = res.body?.results?.entities ?? res.body?.results?.tags ?? res.body?.results ?? res.body;
      const data = Array.isArray(out) ? slim(out) : out;
      trace.push({ tool: c.function.name, args, status: res.status, url: res.url, n: Array.isArray(out) ? out.length : undefined, top: Array.isArray(data) ? data.slice(0, 5) : undefined });
      messages.push({ role: 'tool', tool_call_id: c.id, content: JSON.stringify(data).slice(0, 6000) });
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
