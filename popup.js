/*
 * Popup logic: triggers a scan (done in the background service worker),
 * renders ranked result cards, and supports clear / export / copy.
 */

const $ = (id) => document.getElementById(id);
const RESULTS_KEY = 'lastScan';
let lastResults = [];

function setStatus(msg, isError) {
  const el = $('status');
  el.textContent = msg || '';
  el.className = 'status ' + (isError ? 'error' : (msg ? 'ok' : ''));
}

function fmtTime(utc) {
  if (!utc) return 'unknown date';
  const d = new Date(utc * 1000);
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function snippet(text, n = 220) {
  const t = (text || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
}

// Build one result card. Uses DOM APIs (no innerHTML) to avoid injection.
function renderCard(post) {
  const card = document.createElement('div');
  card.className = 'result-card';

  const title = document.createElement('h3');
  title.textContent = post.title;
  card.appendChild(title);

  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.textContent =
    `r/${post.subreddit} · score ${post.score} · ${post.numComments} comments · ${fmtTime(post.createdUtc)} · by ${post.author}`;
  card.appendChild(meta);

  const scoreBadge = document.createElement('span');
  scoreBadge.className = 'score-badge';
  scoreBadge.textContent = 'Match score: ' + post.score;
  card.appendChild(scoreBadge);

  if (typeof post.llmRelevance === 'number') {
    const ai = document.createElement('span');
    ai.className = 'score-badge ai-badge';
    const intent = post.llmIntent && post.llmIntent !== 'none' ? ' · ' + post.llmIntent : '';
    ai.textContent = `AI relevance: ${post.llmRelevance}/10${intent}`;
    card.appendChild(ai);
  }

  if (post.matchedTerms && post.matchedTerms.length) {
    const terms = document.createElement('div');
    terms.className = 'terms';
    post.matchedTerms.forEach((t) => {
      const chip = document.createElement('span');
      chip.className = 'chip';
      chip.textContent = t;
      terms.appendChild(chip);
    });
    card.appendChild(terms);
  }

  const reason = document.createElement('p');
  reason.className = 'reason';
  reason.textContent = post.reason;
  card.appendChild(reason);

  if (post.llmReason) {
    const aiReason = document.createElement('p');
    aiReason.className = 'reason ai-reason';
    aiReason.textContent = 'AI: ' + post.llmReason;
    card.appendChild(aiReason);
  }

  if (post.selftext) {
    const snip = document.createElement('p');
    snip.className = 'snippet';
    snip.textContent = snippet(post.selftext);
    card.appendChild(snip);
  }

  const actions = document.createElement('div');
  actions.className = 'card-actions';

  const open = document.createElement('a');
  open.className = 'btn small primary';
  open.textContent = 'Open on Reddit';
  open.href = post.permalink;
  open.target = '_blank';
  open.rel = 'noopener noreferrer';
  actions.appendChild(open);

  const copy = document.createElement('button');
  copy.className = 'btn small secondary';
  copy.textContent = 'Copy URL';
  copy.addEventListener('click', () => {
    navigator.clipboard.writeText(post.permalink).then(
      () => { copy.textContent = 'Copied!'; setTimeout(() => (copy.textContent = 'Copy URL'), 1500); },
      () => setStatus('Could not copy to clipboard.', true)
    );
  });
  actions.appendChild(copy);

  card.appendChild(actions);
  return card;
}

function renderResults(results) {
  const container = $('results');
  container.textContent = '';
  if (!results.length) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = 'No matching posts. Try widening your keywords or freshness window in Settings.';
    container.appendChild(empty);
    return;
  }
  results.forEach((p) => container.appendChild(renderCard(p)));
}

async function scan() {
  setStatus('Scanning… this can take a few seconds.');
  $('scan').disabled = true;

  chrome.storage.local.get('config', (data) => {
    const config = Object.assign({}, DEFAULT_CONFIG, data.config || {});
    chrome.runtime.sendMessage({ type: 'SCAN', config }, (resp) => {
      $('scan').disabled = false;

      if (chrome.runtime.lastError) {
        setStatus('Scan failed: ' + chrome.runtime.lastError.message, true);
        return;
      }
      if (!resp || !resp.ok) {
        setStatus(resp && resp.error ? resp.error : 'Scan failed.', true);
        return;
      }

      lastResults = resp.results || [];
      renderResults(lastResults);

      const parts = [`Found ${lastResults.length} matching post(s) across ${resp.scanned} subreddit(s).`];
      let isError = false;
      if (resp.llm && resp.llm.applied) {
        parts.push(`AI re-ranked the top ${resp.llm.scored} (${resp.llm.model}).`);
      } else if (resp.llm && resp.llm.error) {
        parts.push(resp.llm.error);
        isError = true;
      }
      if (resp.errors && resp.errors.length) {
        parts.push('Subreddit issues: ' +
          resp.errors.map((e) => `r/${e.sub} (${e.message})`).join('; '));
        isError = true;
      }
      setStatus(parts.join(' '), isError);

      // Persist so results survive closing the popup.
      chrome.storage.local.set({
        [RESULTS_KEY]: {
          results: lastResults,
          summary: parts[0],
          scannedAt: Date.now(),
        },
      });
    });
  });
}

function exportJson() {
  if (!lastResults.length) { setStatus('Nothing to export yet — run a scan first.', true); return; }
  const blob = new Blob([JSON.stringify(lastResults, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `reddit-leads-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
  setStatus('Exported ' + lastResults.length + ' result(s).');
}

function clearResults() {
  lastResults = [];
  $('results').textContent = '';
  setStatus('');
  chrome.storage.local.remove(RESULTS_KEY);
}

// Restore the previous scan (if any) when the popup opens.
function loadSavedResults() {
  chrome.storage.local.get(RESULTS_KEY, (data) => {
    const saved = data[RESULTS_KEY];
    if (!saved || !Array.isArray(saved.results) || !saved.results.length) return;

    lastResults = saved.results;
    renderResults(lastResults);

    const when = saved.scannedAt
      ? new Date(saved.scannedAt).toLocaleString(undefined, {
          month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
        })
      : 'earlier';
    setStatus(`Showing saved results from ${when}. Click "Scan Reddit" to refresh.`);
  });
}

document.addEventListener('DOMContentLoaded', () => {
  loadSavedResults();
  $('scan').addEventListener('click', scan);
  $('clear').addEventListener('click', clearResults);
  $('export').addEventListener('click', exportJson);
  $('openOptions').addEventListener('click', (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });
});
