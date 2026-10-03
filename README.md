# Hayy <span lang="ar">حيّ</span>

**A taste-grounded marketing agent for small cafés and restaurants.**

Tell Hayy your venue and your neighborhood. It asks [Qloo](https://qloo.com)'s taste graph what the
people *around that venue* actually love, then turns the answer into a menu move, an in-store playlist,
collaboration partners, and a week of Arabic/English social posts — with every line traced back to the
Qloo entity it rests on.

Built for the Qloo Agentic Hackathon.

## The problem

A café owner asking a general-purpose chatbot for marketing ideas gets confident, placeless advice:
the same "try a signature latte and post reels" that it would give a café in any city on earth. It has
no idea who walks past *that* door.

Hayy's whole premise is that the interesting part is not the copywriting — it is knowing the audience.
That is a data problem, and it is the one Qloo solves.

## What makes it different

The UI runs the same brief twice, side by side:

- **Generic AI** — the same question, LLM only, no tools.
- **Hayy** — an agent loop that must ground every claim in Qloo data.

Then it shows you the **Qloo call trace**: every tool call the agent made, the arguments, the HTTP
status, and how many entities came back. You can see the recommendations being earned rather than
asserted.

The agent is also allowed to fail honestly. If Qloo returns no taste data for a venue, Hayy refuses to
produce a brief instead of quietly falling back on the model's own priors:

```js
if (!trace.some(t => t.status === 200 && t.n))
  throw new Error('Qloo returned no taste data for this venue/area, so there is nothing grounded to say.');
```

## How Qloo is used

Three tools are exposed to the model, which plans its own path through them:

| tool | Qloo endpoint | purpose |
|---|---|---|
| `qloo_search` | `/search` | resolve the owner's venue (or comparable nearby venues) to an entity id |
| `qloo_insights` | `/v2/insights` | the core call: signal with entity ids, get back affinity-ranked artists, brands, films, places |
| `qloo_tags` | `/v2/tags` | resolve cuisines/genres/styles to tag ids for narrowing |

The venue's own entity id becomes the taste signal (`signal.interests.entities`), so the artists and
brands that come back are the ones this specific audience is into — not the city's generic top 10.

### Two rules learned the hard way

Both were found by reading the call traces of failed runs, and both are now encoded in the tool
descriptions and the system prompt:

1. **`location` only works with `filter_type: urn:entity:place`.** Combined with `artist`, `brand`,
   `movie` or `tv_show`, Qloo answers `200` with **zero results** rather than an error — so a naive
   agent retries variants forever and burns its call budget. Signal taste with `interest_entities`
   instead and let location filter only place queries.
2. **Never repeat an identical failing call.** Some entity ids return `400` as a taste signal; the fix
   is to change the arguments, not to try again.

Measured effect on identical briefs:

| city | before | after |
|---|---|---|
| Downtown Dubai | 9 calls, 4 with data, 141s | **5 calls, 5 with data, 47s** |
| San Francisco | 8 calls, 5 with data, 151s | **3 calls, 3 with data, 49s** |

Empty-result calls went to zero in every city tested.

## Running it

Requires a Qloo hackathon API key and any OpenAI-compatible LLM endpoint.

```sh
npm i -g wrangler   # or use npx

cat > .dev.vars <<'VARS'
QLOO_KEY=your-qloo-hackathon-key
LLM_BASE=https://generativelanguage.googleapis.com/v1beta/openai
LLM_MODEL=gemini-3.8-flash
LLM_KEY=your-llm-key
VARS

npx wrangler dev --port 8799
```

Then open <http://localhost:8799>.

Deploying:

```sh
npx wrangler secret put QLOO_KEY
npx wrangler secret put LLM_KEY
npx wrangler deploy
```

## API

| route | body | returns |
|---|---|---|
| `POST /api/brief` | `{venue, area, concept?}` | `{brief, trace}` — the grounded brief plus every Qloo call |
| `POST /api/baseline` | same | `{brief}` — LLM only, no tools, for the comparison |

## Layout

```
worker.js           agent loop, Qloo tool definitions, both endpoints
public/index.html   the whole UI: form, side-by-side, call trace
runs/               saved real responses used for the measurements above
```

One Cloudflare Worker, one static page, no build step and no dependencies.

## Notes

- Posts are written for a Saudi audience: natural Saudi-dialect Arabic, no alcohol, no pork.
- Tool results are trimmed to names, ids, affinity and a few tags before reaching the model, to keep
  the context small enough for a long tool loop.
- The LLM call retries on `429` using the provider's own retry hint, and recovers when a model wraps its
  final answer in a bogus tool call — both are routine on free tiers and used to lose whole runs.

## License

MIT — see [LICENSE](LICENSE).
