/*
 * Service worker: performs the Reddit scan on request from the popup.
 *
 * Read-only. Fetches ONLY public subreddit listing JSON that Reddit exposes
 * (e.g. https://www.reddit.com/r/<sub>/top.json). No login, no authenticated
 * endpoints, no writing, voting, commenting, or messaging.
 */

importScripts('defaults.js');

// Throttle between subreddit requests to stay polite / avoid rate limits.
const FETCH_DELAY_MS = 1200;
const REQUEST_TIMEOUT_MS = 12000;

// Freshness window -> seconds, used to filter posts by created time.
const WINDOW_SECONDS = {
  day: 24 * 60 * 60,
  week: 7 * 24 * 60 * 60,
  month: 30 * 24 * 60 * 60,
  year: 365 * 24 * 60 * 60
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Fetch one subreddit's public "top" listing for the chosen time window.
async function fetchSubreddit(sub, freshness, limit) {
  const t = WINDOW_SECONDS[freshness] ? freshness : 'year';
  const capped = Math.min(Math.max(parseInt(limit, 10) || 25, 1), 100);
  const url =
    `https://www.reddit.com/r/${encodeURIComponent(sub)}/top.json` +
    `?t=${t}&limit=${capped}&raw_json=1`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal
    });

    if (res.status === 429) throw new Error('rate-limited');
    if (res.status === 403) throw new Error('blocked');
    if (res.status === 404) throw new Error('not-found');
    if (!res.ok) throw new Error('http-' + res.status);

    const json = await res.json();
    const children = (json && json.data && json.data.children) || [];
    return children
      .filter((c) => c && c.kind === 't3' && c.data)
      .map((c) => c.data);
  } finally {
    clearTimeout(timer);
  }
}

// Normalize a raw Reddit post into just the public fields we care about.
function normalizePost(d) {
  return {
    id: d.id || d.name || d.permalink,
    title: d.title || '(no title)',
    selftext: d.selftext || '',
    subreddit: d.subreddit || '',
    author: d.author && d.author !== '[deleted]' ? d.author : 'unknown',
    score: typeof d.score === 'number' ? d.score : 0,
    numComments: typeof d.num_comments === 'number' ? d.num_comments : 0,
    createdUtc: d.created_utc || 0,
    permalink: d.permalink ? 'https://www.reddit.com' + d.permalink : ''
  };
}

// Count how many terms from a list appear in the text; return the matched ones.
function findMatches(text, terms) {
  const hits = [];
  for (const term of terms) {
    const needle = term.toLowerCase().trim();
    if (needle && text.includes(needle)) hits.push(term);
  }
  return hits;
}

// Score a post and build a human-readable explanation of why it matched.
function scorePost(post, cfg, now) {
  const text = (post.title + ' ' + post.selftext).toLowerCase();

  // Negative filter: skip anything mentioning avoided topics.
  const negatives = findMatches(text, cfg.negativeKeywords || []);
  if (negatives.length) {
    return { excluded: true, reason: 'skipped (negative: ' + negatives.join(', ') + ')' };
  }

  const keywordHits = findMatches(text, cfg.keywords || []);
  const problemHits = findMatches(text, cfg.problemPhrases || []);
  const intentHits = findMatches(text, cfg.buyingIntentPhrases || []);
  const competitorHits = findMatches(text, cfg.competitors || []);

  // Regex-based intent signals.
  const patternHits = [];
  for (const p of INTENT_PATTERNS) {
    if (p.re.test(text)) patternHits.push(p.label);
  }

  // Weight problem phrases highest when the user prioritizes complaints.
  const w = { keyword: 2, problem: 3, intent: 4, competitor: 3 };
  if (cfg.intentPriority === 'complaints') w.problem = 5;
  else if (cfg.intentPriority === 'recommendations') w.intent = 6;
  else if (cfg.intentPriority === 'competitors') w.competitor = 5;

  let score = 0;
  score += keywordHits.length * w.keyword;
  score += problemHits.length * w.problem;
  score += intentHits.length * w.intent;
  score += competitorHits.length * w.competitor;
  score += patternHits.length * 2;

  // Recency: newer posts within the window score higher (up to +3).
  const windowSec = WINDOW_SECONDS[cfg.freshness] || WINDOW_SECONDS.year;
  const ageSec = now - post.createdUtc;
  if (post.createdUtc && ageSec >= 0 && ageSec <= windowSec) {
    score += Math.round(3 * (1 - ageSec / windowSec));
  }

  // Comment activity: a little boost for active threads (up to +2).
  if (post.numComments > 0) {
    score += Math.min(2, Math.round(Math.log10(post.numComments + 1)));
  }

  const anyContentMatch =
    keywordHits.length || problemHits.length || intentHits.length ||
    competitorHits.length || patternHits.length;

  const matchedTerms = [...keywordHits, ...problemHits, ...intentHits, ...competitorHits];
  const reasonBits = [];
  if (matchedTerms.length) reasonBits.push('Matched: ' + matchedTerms.join(', '));
  if (patternHits.length) reasonBits.push('Intent: ' + patternHits.join(', '));

  return {
    excluded: false,
    include: !!anyContentMatch,
    score,
    matchedTerms,
    patternHits,
    reason: reasonBits.join(' | ') || 'No strong signals'
  };
}

// Run the full scan across all configured subreddits.
async function runScan(cfg) {
  const subs = (cfg.subreddits || [])
    .map((s) => cleanSubreddit(s))
    .filter(Boolean);

  if (!subs.length) {
    return { ok: false, error: 'No valid subreddits configured. Open Options and add some.' };
  }
  if (!(cfg.keywords || []).length && !(cfg.problemPhrases || []).length) {
    return { ok: false, error: 'No keywords or problem phrases configured. Open Options first.' };
  }

  const now = Math.floor(Date.now() / 1000);
  const seen = new Set(); // de-dupe by post id / permalink
  const results = [];
  const errors = [];

  for (let i = 0; i < subs.length; i++) {
    const sub = subs[i];
    try {
      const raw = await fetchSubreddit(sub, cfg.freshness, cfg.maxPosts);
      for (const d of raw) {
        const post = normalizePost(d);
        const key = post.id || post.permalink;
        if (!key || seen.has(key)) continue;
        seen.add(key);

        const scored = scorePost(post, cfg, now);
        if (scored.excluded || !scored.include) continue;

        results.push({
          ...post,
          score: scored.score,
          matchedTerms: scored.matchedTerms,
          reason: scored.reason
        });
      }
    } catch (err) {
      errors.push({ sub, message: friendlyError(err) });
    }

    // Polite delay between subreddits (skip after the last one).
    if (i < subs.length - 1) await sleep(FETCH_DELAY_MS);
  }

  results.sort((a, b) => b.score - a.score);

  // Optional second pass: LLM re-ranking of the top lexical candidates.
  let llm = { applied: false };
  if (cfg.llmProvider && cfg.llmProvider !== 'none' && cfg.llmApiKey) {
    try {
      llm = await reRankWithLLM(cfg, results);
    } catch (err) {
      llm = { applied: false, error: friendlyLlmError(err) };
    }
  }

  return { ok: true, results, errors, scanned: subs.length, llm };
}

function friendlyError(err) {
  const m = (err && err.message) || '';
  if (m === 'rate-limited') return 'Reddit rate-limited this request — try again later.';
  if (m === 'blocked') return 'Reddit blocked this request (403).';
  if (m === 'not-found') return 'Subreddit not found or private.';
  if (m.startsWith('http-')) return 'Reddit returned an error (' + m.replace('http-', '') + ').';
  if (err && err.name === 'AbortError') return 'Request timed out.';
  return 'Network error — check your connection.';
}

// --- Optional LLM re-ranking -----------------------------------------------
//
// Sends the top lexical candidates to the user's chosen provider (Anthropic or
// OpenAI) with their own API key, and blends a semantic relevance score into
// the ranking. Uses structured JSON output so parsing is reliable. Read-only:
// it scores public posts, nothing is written back to Reddit.

const LLM_TIMEOUT_MS = 30000;

// Shared JSON schema — valid for both Anthropic structured outputs and
// OpenAI strict json_schema (all keys required, no extra properties).
const LLM_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['results'],
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'relevance', 'intent', 'reason'],
        properties: {
          id: { type: 'string' },
          relevance: { type: 'integer' }, // 0-10, clamped client-side
          intent: {
            type: 'string',
            enum: ['recommendation', 'complaint', 'competitor', 'none']
          },
          reason: { type: 'string' }
        }
      }
    }
  }
};

function llmSystemPrompt(cfg) {
  return (
    'You help a founder find Reddit posts worth manually reviewing as ' +
    'sales-research leads. Do not fabricate posts or ids; only score the ones given.\n' +
    'Product/offer: ' + (cfg.product || '(unspecified)') + '\n' +
    'Ideal customer: ' + (cfg.idealCustomer || '(unspecified)') + '\n' +
    'Priority signal: ' + (cfg.intentPriority || 'complaints') + '\n' +
    'For each post return: relevance (integer 0-10, where 10 means the author is ' +
    'clearly the ideal customer expressing a matching need), intent ' +
    '(recommendation | complaint | competitor | none), and a one-sentence reason.'
  );
}

async function llmFetch(url, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);
  try {
    return await fetch(url, Object.assign({}, options, { signal: controller.signal }));
  } finally {
    clearTimeout(timer);
  }
}

async function callAnthropic(cfg, model, system, userContent) {
  const res = await llmFetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': cfg.llmApiKey,
      'anthropic-version': '2023-06-01',
      // Required for calling the API directly from a browser/extension context.
      'anthropic-dangerous-direct-browser-access': 'true'
    },
    body: JSON.stringify({
      model: model,
      max_tokens: 2048,
      system: system,
      output_config: { format: { type: 'json_schema', schema: LLM_SCHEMA } },
      messages: [{ role: 'user', content: userContent }]
    })
  });

  if (!res.ok) throw new Error('llm-http-' + res.status);
  const json = await res.json();
  if (json.stop_reason === 'refusal') throw new Error('llm-refusal');
  const block = (json.content || []).find((b) => b.type === 'text');
  if (!block || !block.text) throw new Error('llm-empty');
  return JSON.parse(block.text);
}

async function callOpenAI(cfg, model, system, userContent) {
  const res = await llmFetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer ' + cfg.llmApiKey
    },
    body: JSON.stringify({
      model: model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: userContent }
      ],
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'lead_scores', strict: true, schema: LLM_SCHEMA }
      }
    })
  });

  if (!res.ok) throw new Error('llm-http-' + res.status);
  const json = await res.json();
  const content = json.choices && json.choices[0] && json.choices[0].message &&
    json.choices[0].message.content;
  if (!content) throw new Error('llm-empty');
  return JSON.parse(content);
}

// Re-rank in place: blend the LLM relevance into each post's score, attach the
// LLM reason/intent, and re-sort. Returns metadata for the popup.
async function reRankWithLLM(cfg, results) {
  const model = cfg.llmModel || LLM_DEFAULT_MODELS[cfg.llmProvider];
  if (!model) return { applied: false, error: 'Unknown LLM provider.' };

  const topN = Math.min(Math.max(parseInt(cfg.llmTopN, 10) || 12, 1), 25);
  const candidates = results.slice(0, topN).map((p) => ({
    id: p.id,
    subreddit: p.subreddit,
    title: p.title,
    snippet: (p.selftext || '').replace(/\s+/g, ' ').slice(0, 300)
  }));
  if (!candidates.length) return { applied: false };

  const system = llmSystemPrompt(cfg);
  const userContent = 'Score these posts as leads:\n' + JSON.stringify(candidates);

  let parsed;
  if (cfg.llmProvider === 'anthropic') parsed = await callAnthropic(cfg, model, system, userContent);
  else if (cfg.llmProvider === 'openai') parsed = await callOpenAI(cfg, model, system, userContent);
  else return { applied: false };

  const byId = {};
  ((parsed && parsed.results) || []).forEach((r) => { if (r && r.id) byId[r.id] = r; });

  results.forEach((p) => {
    const r = byId[p.id];
    if (!r) return;
    const rel = Math.max(0, Math.min(10, parseInt(r.relevance, 10) || 0));
    p.llmRelevance = rel;
    p.llmIntent = r.intent;
    if (r.reason) p.llmReason = r.reason;
    p.score = p.score + rel * 3; // blend semantic relevance into the lexical score
  });

  results.sort((a, b) => b.score - a.score);
  return { applied: true, model: model, scored: Object.keys(byId).length };
}

function friendlyLlmError(err) {
  const m = (err && err.message) || '';
  if (m === 'llm-refusal') return 'AI declined to score this batch — showing keyword results.';
  if (m === 'llm-empty') return 'AI returned no parseable result — showing keyword results.';
  if (m.indexOf('llm-http-') === 0) {
    const code = m.replace('llm-http-', '');
    if (code === '401') return 'AI rejected the API key (401) — check it in Settings.';
    if (code === '429') return 'AI rate-limited (429) — showing keyword results.';
    return 'AI API error (' + code + ') — showing keyword results.';
  }
  if (err && err.name === 'AbortError') return 'AI request timed out — showing keyword results.';
  return 'AI re-ranking failed — showing keyword results.';
}

// Message bridge from the popup.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === 'SCAN') {
    runScan(msg.config)
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, error: friendlyError(err) }));
    return true; // keep the message channel open for the async response
  }
  return false;
});
