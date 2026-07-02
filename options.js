/*
 * Options / onboarding page logic.
 * Loads config from chrome.storage.local, saves edits back, and provides a
 * local "Generate starter keywords" helper (no external AI calls).
 */

const $ = (id) => document.getElementById(id);

const TEXT_FIELDS = ['niche', 'product', 'idealCustomer'];
const LIST_FIELDS = [
  'subreddits',
  'keywords',
  'problemPhrases',
  'buyingIntentPhrases',
  'competitors',
  'negativeKeywords'
];

function setStatus(msg, isError) {
  const el = $('status');
  el.textContent = msg;
  el.className = 'status ' + (isError ? 'error' : 'ok');
  if (msg) setTimeout(() => { el.textContent = ''; el.className = 'status'; }, 4000);
}

// Populate the form from a config object.
function fillForm(cfg) {
  TEXT_FIELDS.forEach((f) => { $(f).value = cfg[f] || ''; });
  LIST_FIELDS.forEach((f) => { $(f).value = listToLines(cfg[f]); });
  $('freshness').value = cfg.freshness || 'year';
  $('intentPriority').value = cfg.intentPriority || 'complaints';
  $('maxPosts').value = cfg.maxPosts || 25;
  $('llmProvider').value = cfg.llmProvider || 'none';
  $('llmApiKey').value = cfg.llmApiKey || '';
  $('llmModel').value = cfg.llmModel || '';
  $('llmTopN').value = cfg.llmTopN || 12;
  updateLlmHint();
}

// Read the form into a config object.
function readForm() {
  const cfg = {};
  TEXT_FIELDS.forEach((f) => { cfg[f] = $(f).value.trim(); });
  LIST_FIELDS.forEach((f) => { cfg[f] = linesToList($(f).value); });
  cfg.subreddits = cfg.subreddits.map(cleanSubreddit).filter(Boolean);
  cfg.freshness = $('freshness').value;
  cfg.intentPriority = $('intentPriority').value;
  cfg.maxPosts = Math.min(Math.max(parseInt($('maxPosts').value, 10) || 25, 1), 100);
  cfg.llmProvider = $('llmProvider').value;
  cfg.llmApiKey = $('llmApiKey').value.trim();
  cfg.llmModel = $('llmModel').value.trim();
  cfg.llmTopN = Math.min(Math.max(parseInt($('llmTopN').value, 10) || 12, 1), 25);
  return cfg;
}

// Reflect the selected provider: default-model hint + enable/disable fields.
function updateLlmHint() {
  const provider = $('llmProvider').value;
  const enabled = provider !== 'none';
  ['llmApiKey', 'llmModel', 'llmTopN'].forEach((f) => { $(f).disabled = !enabled; });
  const def = LLM_DEFAULT_MODELS[provider];
  $('llmModel').placeholder = def ? `Leave blank for the default (${def})` : 'Leave blank for the provider default';
  $('llmModelHint').textContent = enabled
    ? `Default model if left blank: ${def}. Requests go straight to the ${provider === 'anthropic' ? 'Anthropic' : 'OpenAI'} API from your browser.`
    : 'Re-ranking is off — results are ranked by keyword matching alone.';
}

function load() {
  chrome.storage.local.get('config', (data) => {
    fillForm(Object.assign({}, DEFAULT_CONFIG, data.config || {}));
  });
}

function save() {
  const cfg = readForm();
  if (!cfg.subreddits.length) { setStatus('Add at least one subreddit before saving.', true); return; }
  chrome.storage.local.set({ config: cfg }, () => setStatus('Saved.'));
}

// --- Local starter-keyword generator (simple, no AI) ---------------------

const STOPWORDS = new Set(
  ('a an and are as at be but by for from has have i if in into is it its of on or ' +
   'that the their them then there they this to was were will with you your our we ' +
   'create take make help tool tools app apps software solution product service ' +
   'plan them these those what who how when where why not do does can will able').split(' ')
);

// Pull candidate keywords from the free-text product/niche fields.
function keywordsFromText(text) {
  const words = (text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 3 && !STOPWORDS.has(w));

  const freq = {};
  words.forEach((w) => { freq[w] = (freq[w] || 0) + 1; });

  // Build a few two-word phrases from adjacent meaningful words too.
  const phrases = [];
  for (let i = 0; i < words.length - 1; i++) phrases.push(words[i] + ' ' + words[i + 1]);

  const single = Object.keys(freq).sort((a, b) => freq[b] - freq[a]).slice(0, 10);
  return [...new Set([...single, ...phrases.slice(0, 6)])];
}

function generateStarters() {
  const cfg = readForm();
  const derived = keywordsFromText(cfg.product + ' ' + cfg.niche + ' ' + cfg.idealCustomer);

  // Merge derived keywords with existing + the tailored defaults, de-duped.
  const mergedKeywords = linesToList(
    [...cfg.keywords, ...derived, ...DEFAULT_CONFIG.keywords].join('\n')
  );
  $('keywords').value = listToLines(mergedKeywords);

  // Seed the other buckets from defaults only if the user left them empty.
  if (!cfg.problemPhrases.length) $('problemPhrases').value = listToLines(DEFAULT_CONFIG.problemPhrases);
  if (!cfg.buyingIntentPhrases.length) $('buyingIntentPhrases').value = listToLines(DEFAULT_CONFIG.buyingIntentPhrases);
  if (!cfg.negativeKeywords.length) $('negativeKeywords').value = listToLines(DEFAULT_CONFIG.negativeKeywords);
  if (!cfg.subreddits.length) $('subreddits').value = listToLines(DEFAULT_CONFIG.subreddits);

  setStatus('Starter keywords generated — review, edit, then Save.');
}

// --- wiring --------------------------------------------------------------

document.addEventListener('DOMContentLoaded', () => {
  load();
  $('save').addEventListener('click', save);
  $('generate').addEventListener('click', generateStarters);
  $('llmProvider').addEventListener('change', updateLlmHint);
  $('reset').addEventListener('click', () => {
    fillForm(DEFAULT_CONFIG);
    setStatus('Loaded starter defaults — Save to keep them.');
  });
});
