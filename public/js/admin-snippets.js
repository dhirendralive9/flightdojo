// Admin UI for code snippets.
// Three views:
//   1. /admin/snippets             — list (table) with toggles + delete
//   2. /admin/snippets/new         — create form
//   3. /admin/snippets/:id/edit    — edit form
//   4. /admin/snippets/:id/revisions — read-only history with restore buttons
//
// EJS templates are expected to mark elements with data-* attributes that
// this file binds against. Server-rendered fields populate the form; this
// file handles submit, toggle, delete, preview, and restore.

(function () {
  'use strict';

  // ─── Utilities ──────────────────────────────────────────────────────────

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.from((root || document).querySelectorAll(sel)); }

  async function api(method, url, body) {
    const opts = {
      method,
      headers: { 'Accept': 'application/json' },
      credentials: 'same-origin'
    };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(url, opts);
    let data = null;
    try { data = await res.json(); } catch (e) { /* non-JSON */ }
    return { ok: res.ok, status: res.status, data };
  }

  function flash(message, kind) {
    const el = $('[data-flash]');
    if (!el) { console.log('[flash]', kind || 'info', message); return; }
    el.textContent = message;
    el.className = 'flash flash-' + (kind || 'info');
    el.hidden = false;
    if (kind !== 'error') {
      setTimeout(() => { el.hidden = true; }, 3000);
    }
  }

  function showFieldErrors(errors) {
    // Clear previous
    $$('[data-field-error]').forEach(el => { el.textContent = ''; el.hidden = true; });
    if (!errors) return;
    Object.entries(errors).forEach(([field, msg]) => {
      const el = $(`[data-field-error="${field}"]`);
      if (el) { el.textContent = msg; el.hidden = false; }
    });
  }

  // ─── LIST VIEW ──────────────────────────────────────────────────────────

  function initListView() {
    const root = $('[data-snippets-list]');
    if (!root) return;

    // Toggle active
    $$('[data-toggle-active]', root).forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.preventDefault();
        const id = btn.dataset.toggleActive;
        btn.disabled = true;
        const { ok, data } = await api('POST', `/api/admin/snippets/${id}/toggle`);
        btn.disabled = false;
        if (!ok) {
          flash(data?.message || 'Could not toggle. Check your role.', 'error');
          return;
        }
        const row = btn.closest('[data-snippet-row]');
        if (row) row.dataset.active = data.snippet.active ? '1' : '0';
        btn.textContent = data.snippet.active ? 'On' : 'Off';
        btn.setAttribute('aria-pressed', data.snippet.active ? 'true' : 'false');
        flash(`Snippet ${data.snippet.active ? 'enabled' : 'disabled'}.`, 'success');
      });
    });

    // Delete
    $$('[data-delete]', root).forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.preventDefault();
        const id = btn.dataset.delete;
        const name = btn.dataset.name || 'this snippet';
        if (!confirm(`Permanently delete "${name}"? This cannot be undone (revision history will also be lost).`)) return;
        btn.disabled = true;
        const { ok, data } = await api('DELETE', `/api/admin/snippets/${id}`);
        btn.disabled = false;
        if (!ok) {
          flash(data?.message || 'Delete failed.', 'error');
          return;
        }
        const row = btn.closest('[data-snippet-row]');
        if (row) row.remove();
        flash('Snippet deleted.', 'success');
      });
    });

    // Filter / search box
    const filterInput = $('[data-snippet-filter]', root);
    if (filterInput) {
      filterInput.addEventListener('input', () => {
        const q = filterInput.value.trim().toLowerCase();
        $$('[data-snippet-row]', root).forEach(row => {
          const haystack = row.dataset.searchText || row.textContent.toLowerCase();
          row.hidden = q && !haystack.includes(q);
        });
      });
    }
  }

  // ─── EDIT / NEW FORM ────────────────────────────────────────────────────

  function gatherFormData(form) {
    const fd = new FormData(form);
    // Convert path textareas (newline-separated) to arrays
    const splitLines = (s) => String(s || '')
      .split(/[\n,]/)
      .map(x => x.trim())
      .filter(Boolean);
    return {
      name: fd.get('name'),
      description: fd.get('description'),
      placement: fd.get('placement'),
      scope: fd.get('scope'),
      code: fd.get('code'),
      active: fd.get('active') === 'on' || fd.get('active') === '1' || fd.get('active') === 'true',
      priority: parseInt(fd.get('priority'), 10) || 100,
      include_paths: splitLines(fd.get('include_paths')),
      exclude_paths: splitLines(fd.get('exclude_paths')),
      note: fd.get('note') || ''
    };
  }

  function initEditView() {
    const form = $('[data-snippet-form]');
    if (!form) return;

    const id = form.dataset.snippetId || null;   // empty/missing = new
    const submitBtn = $('[data-submit]', form);

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      showFieldErrors(null);
      submitBtn.disabled = true;
      submitBtn.dataset.originalText = submitBtn.dataset.originalText || submitBtn.textContent;
      submitBtn.textContent = 'Saving…';

      const payload = gatherFormData(form);
      const method = id ? 'PUT' : 'POST';
      const url = id ? `/api/admin/snippets/${id}` : '/api/admin/snippets';
      const { ok, status, data } = await api(method, url, payload);

      submitBtn.disabled = false;
      submitBtn.textContent = submitBtn.dataset.originalText;

      if (!ok) {
        if (status === 400 || status === 409) {
          showFieldErrors(data?.errors || {});
          flash('Please fix the highlighted fields.', 'error');
        } else if (status === 403) {
          flash('Your role does not allow this action. Owner or manager required.', 'error');
        } else {
          flash(data?.message || 'Save failed.', 'error');
        }
        return;
      }

      flash('Saved.', 'success');
      // On create, jump to the edit page so further saves are PUT
      if (!id && data.snippet?._id) {
        setTimeout(() => {
          window.location.href = `/admin/snippets/${data.snippet._id}/edit`;
        }, 600);
      }
    });

    // Preview button — opens a small panel showing which snippets would
    // render at a given path. Doesn't require saving first.
    const previewBtn = $('[data-preview-btn]');
    const previewPath = $('[data-preview-path]');
    const previewOut = $('[data-preview-out]');
    if (previewBtn && previewPath && previewOut) {
      previewBtn.addEventListener('click', async (e) => {
        e.preventDefault();
        const path = previewPath.value.trim() || '/';
        previewOut.textContent = 'Loading…';
        const { ok, data } = await api('GET', `/api/admin/snippets/_preview?path=${encodeURIComponent(path)}`);
        if (!ok) {
          previewOut.textContent = 'Preview failed.';
          return;
        }
        const lines = [];
        lines.push(`Path: ${data.path}`);
        lines.push('');
        lines.push(`Header snippets (${data.header.length}):`);
        data.header.forEach(s => lines.push(`  · ${s.name}  [${s.scope}, priority ${s.priority}]`));
        if (data.header.length === 0) lines.push('  (none)');
        lines.push('');
        lines.push(`Footer snippets (${data.footer.length}):`);
        data.footer.forEach(s => lines.push(`  · ${s.name}  [${s.scope}, priority ${s.priority}]`));
        if (data.footer.length === 0) lines.push('  (none)');
        previewOut.textContent = lines.join('\n');
      });
    }
  }

  // ─── REVISIONS VIEW ─────────────────────────────────────────────────────

  function initRevisionsView() {
    const root = $('[data-revisions-list]');
    if (!root) return;
    const snippetId = root.dataset.snippetId;
    if (!snippetId) return;

    $$('[data-restore]', root).forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.preventDefault();
        const idx = btn.dataset.restore;
        if (!confirm('Restore this revision? The current body will be saved as a new revision before being overwritten.')) return;
        btn.disabled = true;
        const { ok, data } = await api('POST', `/api/admin/snippets/${snippetId}/restore/${idx}`);
        btn.disabled = false;
        if (!ok) {
          flash(data?.message || 'Restore failed.', 'error');
          return;
        }
        flash('Restored. Redirecting…', 'success');
        setTimeout(() => {
          window.location.href = `/admin/snippets/${snippetId}/edit`;
        }, 600);
      });
    });
  }

  // ─── BOOT ───────────────────────────────────────────────────────────────

  document.addEventListener('DOMContentLoaded', () => {
    initListView();
    initEditView();
    initRevisionsView();
  });
})();
