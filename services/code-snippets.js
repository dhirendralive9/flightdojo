// Code-snippet loader, cache, and render helpers.
//
// We don't want to hit MongoDB twice (header + footer) on every page render,
// so the full active set is held in memory and busted on writes via
// invalidateCache(). For multi-process deployments, set a short TTL via
// CODE_SNIPPETS_CACHE_MS (default 60s) so other workers eventually pick up
// admin changes even without IPC.

const CodeSnippet = require('../models/CodeSnippet');
const { shouldNoIndex } = require('./seo');

const CACHE_TTL_MS = parseInt(process.env.CODE_SNIPPETS_CACHE_MS || '60000', 10);

let cache = {
  loaded_at: 0,
  snippets: []          // all active snippets, sorted by priority then createdAt
};

let inflight = null;    // dedupe concurrent reloads

async function loadActive() {
  const docs = await CodeSnippet
    .find({ active: true })
    .sort({ priority: 1, createdAt: 1 })
    .lean();
  // .lean() returns plain objects — fine since we only read.
  return docs;
}

async function ensureFresh() {
  const age = Date.now() - cache.loaded_at;
  if (age < CACHE_TTL_MS && cache.snippets.length >= 0 && cache.loaded_at > 0) {
    return cache.snippets;
  }
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const snippets = await loadActive();
      cache = { loaded_at: Date.now(), snippets };
      return snippets;
    } catch (err) {
      console.warn('CodeSnippet loadActive failed:', err.message);
      // Keep serving the previous cache rather than blanking the site.
      return cache.snippets;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

function invalidateCache() {
  cache.loaded_at = 0;
}

// Decide whether a given snippet applies to a given request path.
// Order:
//   1. include_paths (if any) — must match one, otherwise skip
//   2. exclude_paths — must NOT match any
//   3. scope vs. shouldNoIndex(path)
function pathMatches(pattern, path) {
  if (!pattern) return false;
  // Exact match
  if (pattern === path) return true;
  // Prefix match (with or without trailing wildcard)
  const prefix = pattern.endsWith('*') ? pattern.slice(0, -1) : pattern;
  if (prefix && (path === prefix || path.startsWith(prefix.endsWith('/') ? prefix : prefix + '/'))) {
    return true;
  }
  return false;
}

function snippetAppliesTo(snippet, path) {
  if (snippet.include_paths && snippet.include_paths.length > 0) {
    const hit = snippet.include_paths.some(p => pathMatches(p, path));
    if (!hit) return false;
  }
  if (snippet.exclude_paths && snippet.exclude_paths.length > 0) {
    const hit = snippet.exclude_paths.some(p => pathMatches(p, path));
    if (hit) return false;
  }
  if (snippet.scope === 'all') return true;
  const isInternal = shouldNoIndex(path);
  if (snippet.scope === 'internal') return isInternal;
  if (snippet.scope === 'external') return !isInternal;
  return false;
}

// Express middleware. Attaches:
//   res.locals.snippets_header  → string of concatenated <head> snippets
//   res.locals.snippets_footer  → string of concatenated pre-</body> snippets
//
// Templates render these with raw output (in EJS: <%- snippets_header %>).
async function attachSnippets(req, res, next) {
  try {
    const all = await ensureFresh();
    const path = req.path || '/';
    let header = '';
    let footer = '';
    for (const s of all) {
      if (!snippetAppliesTo(s, path)) continue;
      // Wrap each one in an HTML comment so view-source shows where each
      // block came from. Helps a lot when an admin asks "is GA loading?"
      const wrapped =
        `\n<!-- snippet:${s.name.replace(/-->/g, '--&gt;')} -->\n` +
        s.code +
        `\n<!-- /snippet:${s.name.replace(/-->/g, '--&gt;')} -->\n`;
      if (s.placement === 'header') header += wrapped;
      else footer += wrapped;
    }
    res.locals.snippets_header = header;
    res.locals.snippets_footer = footer;
  } catch (err) {
    console.warn('attachSnippets failed:', err.message);
    res.locals.snippets_header = '';
    res.locals.snippets_footer = '';
  }
  next();
}

// Render the snippets that WOULD apply to a given path, without going through
// the request cycle. Used by the admin preview endpoint.
async function renderForPath(path) {
  const all = await ensureFresh();
  const matched = all.filter(s => snippetAppliesTo(s, path));
  return {
    header: matched.filter(s => s.placement === 'header'),
    footer: matched.filter(s => s.placement === 'footer'),
    path
  };
}

module.exports = {
  attachSnippets,
  invalidateCache,
  renderForPath,
  snippetAppliesTo,   // exported for tests
  pathMatches         // exported for tests
};
