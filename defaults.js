/*
 * Shared default configuration and small helpers.
 * Loaded by popup.html and options.html via <script>, and by
 * background.js via importScripts(). Keeps the starter strategy in one place.
 */

// Tailored starter strategy generated from the onboarding questionnaire.
// Everything here is editable on the Options page.
const DEFAULT_CONFIG = {
  niche: 'Founders / PMs who can build software but do not yet know what problem to solve',
  product:
    'A research workflow tool: create a research plan, run interviews, take notes, highlight, extract problems, and prioritize them.',
  idealCustomer:
    'Solo founders and product managers who have the skills to build but are stuck finding real demand from research.',

  subreddits: [
    'startups',
    'Entrepreneur',
    'SaaS',
    'ProductManagement',
    'indiehackers',
    'UXResearch',
    'userexperience',
    'EntrepreneurRideAlong',
    'nocode'
  ],

  keywords: [
    'user research',
    'customer research',
    'user interviews',
    'customer interviews',
    'product discovery',
    'problem discovery',
    'idea validation',
    'validate demand',
    'talk to users',
    'research notes',
    'interview notes'
  ],

  problemPhrases: [
    "don't know what to build",
    "can't find a problem",
    'stuck on what to build',
    'no idea what problem to solve',
    'struggling to find demand',
    'how do i validate my idea',
    'drowning in interview notes',
    "can't make sense of my interviews",
    'how do i organize research',
    'analysis paralysis'
  ],

  buyingIntentPhrases: [
    'what tool do you use',
    'any recommendations',
    'alternative to',
    'looking for software',
    'looking for a tool',
    'is there a better way',
    'best tool for',
    'how do i automate'
  ],

  competitors: ['Dovetail', 'Notion', 'Google Docs', 'Airtable', 'Otter.ai', 'Aurelius'],

  negativeKeywords: [
    'medical',
    'legal',
    'financial',
    'crypto',
    'nsfw',
    'politics',
    'hiring',
    'salary',
    'giveaway',
    'for hire'
  ],

  // Reddit "top" time filter: day = 24h, week = 7d, month = 30d, year = 12 months.
  freshness: 'year',
  maxPosts: 25,

  // Which intent to weight most heavily. Matches onboarding answer "complaints".
  // one of: 'complaints' | 'recommendations' | 'competitors'
  intentPriority: 'complaints',

  // --- Optional LLM re-ranking (bring your own key) --------------------------
  // Second pass: the top lexical candidates are sent to an LLM for a semantic
  // relevance score, intent label, and a one-line reason. Fully optional — with
  // provider 'none' (or no key) the extension stays pure lexical matching.
  // The key is your own and is stored only in chrome.storage.local.
  llmProvider: 'none', // 'none' | 'anthropic' | 'openai'
  llmApiKey: '',
  llmModel: '', // blank -> provider default (Anthropic: claude-haiku-4-5, OpenAI: gpt-4o-mini)
  llmTopN: 12 // how many top lexical candidates to send per scan (1-25)
};

// Default model per provider when the user leaves the model field blank.
const LLM_DEFAULT_MODELS = {
  anthropic: 'claude-haiku-4-5',
  openai: 'gpt-4o-mini'
};

// Intent regex patterns surfaced in the "reason" for each match.
const INTENT_PATTERNS = [
  { label: 'asking what tool to use', re: /what (tool|software|app)s? (do|does|are) .{0,20}(use|recommend)/i },
  { label: 'asking for recommendations', re: /\b(any )?recommendations?\b|\brecommend (a|an|any|some)\b/i },
  { label: 'looking for an alternative', re: /\balternative(s)? to\b|\bbetter (than|alternative)\b/i },
  { label: 'looking for software/tool', re: /\blooking for (a |an |some )?(tool|software|app|solution)/i },
  { label: 'wants to automate', re: /\bhow (do|can) i automate\b|\bautomate this\b/i },
  { label: 'wants a better way', re: /\bis there a better way\b|\bbetter way to\b/i },
  { label: 'struggling / complaining', re: /\bstruggling with\b|\bcan't figure out\b|\bstuck (on|with)\b|\bfrustrated with\b|\bdrowning in\b/i }
];

// Helper: split a textarea value into a clean, de-duped list of lines.
function linesToList(text) {
  const seen = new Set();
  const out = [];
  (text || '').split('\n').forEach((raw) => {
    const v = raw.trim();
    if (v && !seen.has(v.toLowerCase())) {
      seen.add(v.toLowerCase());
      out.push(v);
    }
  });
  return out;
}

// Helper: turn a list into textarea text.
function listToLines(list) {
  return (list || []).join('\n');
}

// Sanitize a subreddit name: strip "r/", "/r/", url bits, spaces, invalid chars.
function cleanSubreddit(name) {
  return (name || '')
    .trim()
    .replace(/^https?:\/\/(www\.)?reddit\.com/i, '')
    .replace(/^\/?r\//i, '')
    .replace(/\/.*$/, '')
    .replace(/[^A-Za-z0-9_]/g, '')
    .trim();
}

// Expose for service worker (importScripts) — harmless in window context too.
if (typeof self !== 'undefined') {
  self.DEFAULT_CONFIG = DEFAULT_CONFIG;
  self.LLM_DEFAULT_MODELS = LLM_DEFAULT_MODELS;
  self.INTENT_PATTERNS = INTENT_PATTERNS;
  self.linesToList = linesToList;
  self.listToLines = listToLines;
  self.cleanSubreddit = cleanSubreddit;
}
