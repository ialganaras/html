/* ============================================================================
 * _editor.js — editor de artifacts HTML (standalone)
 * ----------------------------------------------------------------------------
 * Uso: agregar al final del <body> de cualquier HTML:
 *      <script src="/_editor.js"></script>
 * y marcar las regiones editables con el atributo  data-editable.
 *
 * - El editor (toolbar + chrome) SOLO aparece si la URL trae  ?edit=si.
 *   Sin eso → vista limpia para terceros (el script no inyecta nada).
 * - Dirty-tracking por SNAPSHOT: al entrar en modo edición se toma una foto
 *   del contenido editable y se compara. No marca "sin guardar" a ciegas.
 * - Autoinyecta sus propios estilos y DOM (toolbar, overlay de historial).
 *   Usa las CSS vars del host si existen, con fallbacks propios si no.
 * - Servido por el Worker html-commit (serve/save/list/revert).
 * ========================================================================== */
(function () {
  'use strict';

  /* ---- Gate: el editor solo se monta con ?edit=si ---- */
  var params = new URLSearchParams(location.search);
  if (params.get('edit') !== 'si') return;

  /* ---- Estilos del chrome del editor (con fallbacks, no dependen del host) ---- */
  var CSS = `
  .ed-toolbar{
    position:fixed;bottom:22px;left:50%;transform:translateX(-50%);
    display:flex;gap:6px;align-items:center;z-index:9999;
    background:var(--code-bg,#23201B);color:var(--code-fg,#EDE6D6);
    padding:7px 8px 7px 16px;border-radius:40px;
    box-shadow:0 8px 30px rgba(33,29,24,.28);
    font-family:"JetBrains Mono",ui-monospace,monospace;font-size:12px;letter-spacing:.03em;
  }
  .ed-toolbar .status{display:flex;align-items:center;gap:8px;opacity:.85;min-width:160px}
  .ed-toolbar .led{width:8px;height:8px;border-radius:50%;background:#6b6357;transition:.25s;flex-shrink:0}
  .ed-toolbar.editing .led{background:var(--code-accent,#D89A6A);box-shadow:0 0 10px var(--code-accent,#D89A6A)}
  .ed-toolbar.dirty .led{background:var(--warn,#E0A24A);box-shadow:0 0 10px var(--warn,#E0A24A)}
  .ed-toolbar.saving .led{background:#d8c46a}
  .ed-toolbar.ok .led{background:var(--ok,#7AA67E);box-shadow:0 0 10px var(--ok,#7AA67E)}
  .ed-toolbar.err .led{background:var(--err,#C26F5A);box-shadow:0 0 10px var(--err,#C26F5A)}
  .ed-toolbar button{
    font-family:inherit;font-size:12px;letter-spacing:.03em;cursor:pointer;
    border:none;border-radius:30px;padding:9px 16px;font-weight:500;transition:.18s;
  }
  .ed-toolbar button:disabled{opacity:.5;cursor:not-allowed}
  .ed-btn-edit{background:var(--code-accent,#D89A6A);color:#241a10}
  .ed-btn-edit:hover:not(:disabled){filter:brightness(1.08)}
  .ed-btn-save{background:transparent;color:var(--code-fg,#EDE6D6);border:1px solid #4a443b !important}
  .ed-btn-save:hover:not(:disabled){background:#332f28}
  .ed-toolbar.dirty .ed-btn-save{
    background:var(--warn,#E0A24A);color:#241a10;border-color:var(--warn,#E0A24A) !important;
    animation:ed-pulse-warn 2s ease-in-out infinite;
  }
  .ed-toolbar.dirty .ed-btn-save:hover:not(:disabled){filter:brightness(1.08)}
  @keyframes ed-pulse-warn{
    0%,100%{box-shadow:0 0 0 0 rgba(224,162,74,.5)}
    50%{box-shadow:0 0 0 6px rgba(224,162,74,0)}
  }
  .ed-btn-icon{background:transparent;color:var(--code-fg,#EDE6D6);width:34px;padding:9px 0;font-size:14px}
  .ed-btn-icon:hover{background:#332f28}

  body.ed-editing [data-editable]{
    outline:1.5px dashed rgba(142,59,46,.45);
    outline-offset:5px;border-radius:3px;transition:outline-color .2s;
  }
  body.ed-editing [data-editable]:hover{outline-color:var(--accent,#8E3B2E)}
  body.ed-editing [data-editable]:focus{
    outline:1.5px solid var(--accent,#8E3B2E);background:rgba(216,154,106,.10);
  }

  .ed-banner{
    position:fixed;top:0;left:0;right:0;z-index:9998;
    background:var(--warn,#E0A24A);color:#241a10;
    font-family:"JetBrains Mono",ui-monospace,monospace;font-size:12px;
    text-align:center;padding:8px 16px;letter-spacing:.03em;
  }
  .ed-banner a{color:#241a10;text-decoration:underline}
  body.ed-has-banner{padding-top:36px}

  .ed-overlay{
    position:fixed;inset:0;background:rgba(33,29,24,.55);
    backdrop-filter:blur(4px);z-index:10000;
    display:none;align-items:center;justify-content:center;padding:20px;
  }
  .ed-overlay.show{display:flex}
  .ed-panel{
    background:var(--paper-2,#FCFAF4);color:var(--ink,#211D18);border-radius:14px;
    width:100%;max-width:520px;max-height:80vh;display:flex;flex-direction:column;
    box-shadow:0 30px 80px rgba(33,29,24,.5);
    border:1px solid var(--line,#DED4C2);overflow:hidden;
  }
  .ed-panel header{
    display:flex;align-items:center;justify-content:space-between;
    padding:18px 22px;border-bottom:1px solid var(--line,#DED4C2);
  }
  .ed-panel h3{
    font-family:"Instrument Serif",Georgia,serif;font-size:22px;font-weight:400;letter-spacing:-.01em;
  }
  .ed-panel .close{
    background:transparent;border:none;font-size:22px;cursor:pointer;
    color:var(--ink-faint,#8C8475);line-height:1;padding:4px 8px;border-radius:6px;
  }
  .ed-panel .close:hover{background:var(--line,#DED4C2);color:var(--ink,#211D18)}
  .ed-panel .pbody{padding:8px 0;overflow-y:auto;flex:1}
  .ed-panel .empty{padding:40px 22px;text-align:center;color:var(--ink-faint,#8C8475);font-style:italic}
  .ed-commit{
    padding:14px 22px;border-bottom:1px dashed var(--line,#DED4C2);
    display:flex;flex-direction:column;gap:8px;
  }
  .ed-commit:last-child{border-bottom:none}
  .ed-commit:hover{background:rgba(216,154,106,.06)}
  .ed-commit .when{
    font-family:"JetBrains Mono",ui-monospace,monospace;font-size:11px;
    letter-spacing:.04em;color:var(--ink-faint,#8C8475);text-transform:uppercase;
  }
  .ed-commit .when .sha{color:var(--accent,#8E3B2E);margin-left:6px}
  .ed-commit .msg{font-size:15px;line-height:1.4;color:var(--ink,#211D18)}
  .ed-commit .actions{display:flex;gap:8px;margin-top:2px}
  .ed-commit .actions button{
    font-family:"JetBrains Mono",ui-monospace,monospace;font-size:11px;letter-spacing:.04em;
    cursor:pointer;border:1px solid var(--line,#DED4C2);background:var(--paper,#F6F1E7);
    color:var(--ink,#211D18);border-radius:20px;padding:6px 12px;transition:.15s;
  }
  .ed-commit .actions button:hover{background:var(--ink,#211D18);color:var(--paper,#F6F1E7);border-color:var(--ink,#211D18)}
  .ed-commit .actions button.danger:hover{background:var(--err,#C26F5A);border-color:var(--err,#C26F5A);color:#fff}
  .ed-commit.current{background:rgba(142,59,46,.06)}
  .ed-commit.current .when::after{
    content:"actual";margin-left:8px;
    background:var(--accent,#8E3B2E);color:#fff;padding:1px 6px;border-radius:8px;font-size:9px;
  }

  .ed-comment-target{outline:2px solid var(--code-accent,#D89A6A) !important;outline-offset:6px}
  .ed-comment-badge,
  .ed-comment-action{
    position:absolute;z-index:9997;min-width:30px;height:26px;padding:0 8px;
    border:none;border-radius:999px;background:var(--code-bg,#23201B);color:var(--code-fg,#EDE6D6);
    box-shadow:0 5px 18px rgba(33,29,24,.22);cursor:pointer;
    font-family:"JetBrains Mono",ui-monospace,monospace;font-size:11px;line-height:26px;
  }
  .ed-comment-action{display:none;width:34px;height:34px;min-width:34px;padding:0;line-height:34px;font-size:15px;background:var(--accent,#8E3B2E);color:#fff}
  .ed-comment-action.show{display:block}
  .ed-comment-badge:hover,.ed-comment-action:hover{background:var(--accent,#8E3B2E);color:#fff;filter:brightness(1.08)}
  .ed-comments-pop{
    position:absolute;z-index:10001;width:min(340px,calc(100vw - 28px));display:none;
    background:var(--paper-2,#FCFAF4);color:var(--ink,#211D18);border:1px solid var(--line,#DED4C2);
    border-radius:14px;box-shadow:0 18px 60px rgba(33,29,24,.35);overflow:hidden;
    font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
  }
  .ed-comments-pop.show{display:block}
  .ed-comments-pop header{display:flex;justify-content:space-between;align-items:center;padding:12px 14px;border-bottom:1px solid var(--line,#DED4C2)}
  .ed-comments-pop h3{font-family:"Instrument Serif",Georgia,serif;font-size:20px;font-weight:400;margin:0}
  .ed-comments-pop .close{background:transparent;border:none;color:var(--ink-faint,#8C8475);cursor:pointer;font-size:20px;line-height:1;padding:2px 6px;border-radius:6px}
  .ed-comments-pop .close:hover{background:var(--line,#DED4C2);color:var(--ink,#211D18)}
  .ed-comments-list{max-height:240px;overflow:auto;padding:8px 0}
  .ed-comment-empty{padding:18px 14px;color:var(--ink-faint,#8C8475);font-style:italic;font-size:13px}
  .ed-comment{padding:11px 14px;border-bottom:1px dashed var(--line,#DED4C2);display:flex;flex-direction:column;gap:6px}
  .ed-comment:last-child{border-bottom:none}
  .ed-comment .meta{font-family:"JetBrains Mono",ui-monospace,monospace;font-size:10px;letter-spacing:.04em;text-transform:uppercase;color:var(--ink-faint,#8C8475)}
  .ed-comment .quote{font-size:12px;color:var(--ink-soft,#5C544A);border-left:2px solid var(--line,#DED4C2);padding-left:8px;line-height:1.35}
  .ed-comment .text{font-size:14px;line-height:1.45;white-space:pre-wrap}
  .ed-comment .delete{align-self:flex-start;border:1px solid var(--line,#DED4C2);background:transparent;color:var(--ink-soft,#5C544A);border-radius:999px;padding:5px 10px;cursor:pointer;font-size:11px}
  .ed-comment .delete:hover{background:var(--err,#C26F5A);border-color:var(--err,#C26F5A);color:#fff}
  .ed-comment-form{border-top:1px solid var(--line,#DED4C2);padding:12px 14px;display:flex;flex-direction:column;gap:8px}
  .ed-comment-form textarea{width:100%;min-height:72px;resize:vertical;border:1px solid var(--line,#DED4C2);border-radius:10px;padding:9px 10px;background:#fff;color:var(--ink,#211D18);font:13px/1.4 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;box-sizing:border-box}
  .ed-comment-form .hint{font-size:11px;color:var(--ink-faint,#8C8475)}
  .ed-comment-form button{align-self:flex-end;border:none;border-radius:999px;background:var(--accent,#8E3B2E);color:#fff;padding:8px 13px;cursor:pointer;font-size:12px}
  .ed-comment-form button:hover{filter:brightness(1.08)}

  @media(max-width:560px){
    .ed-toolbar{font-size:11px}
    .ed-toolbar .status{min-width:120px}
  }`;

  var style = document.createElement('style');
  style.setAttribute('data-editor-ui', '1');
  style.textContent = CSS;
  document.head.appendChild(style);

  /* ---- DOM: toolbar + overlay (marcados data-editor-ui para no commitearlos) ---- */
  var bar = document.createElement('div');
  bar.className = 'ed-toolbar';
  bar.setAttribute('data-editor-ui', '1');
  bar.innerHTML =
    '<div class="status"><span class="led"></span><span class="ed-mode">solo lectura</span></div>' +
    '<button class="ed-btn-edit ed-toggle">Modo edición</button>' +
    '<button class="ed-btn-save ed-save">Guardar</button>' +
    '<button class="ed-btn-icon ed-comments" title="Comentarios del bloque">💬</button>' +
    '<button class="ed-btn-icon ed-history" title="Versiones">📜</button>' +
    '<button class="ed-btn-icon ed-refresh" title="Recargar desde server">↻</button>' +
    '<button class="ed-btn-icon ed-share" title="Copiar link compartible">🔗</button>' +
    '<button class="ed-btn-icon ed-cfg" title="Configurar Worker URL (solo en htmlpreview)">⚙</button>';
  document.body.appendChild(bar);

  var overlay = document.createElement('div');
  overlay.className = 'ed-overlay';
  overlay.setAttribute('data-editor-ui', '1');
  overlay.innerHTML =
    '<div class="ed-panel">' +
      '<header><h3>Versiones de este archivo</h3>' +
      '<button class="close ed-close" title="Cerrar">✕</button></header>' +
      '<div class="pbody ed-hbody"><div class="empty">Cargando…</div></div>' +
    '</div>';
  document.body.appendChild(overlay);

  var commentsPop = document.createElement('div');
  commentsPop.className = 'ed-comments-pop';
  commentsPop.setAttribute('data-editor-ui', '1');
  commentsPop.innerHTML =
    '<header><h3>Comentarios</h3><button class="close ed-cpop-close" title="Cerrar">✕</button></header>' +
    '<div class="ed-comments-list"></div>' +
    '<div class="ed-comment-form">' +
      '<textarea class="ed-comment-text" placeholder="Comentario sobre este bloque…"></textarea>' +
      '<div class="hint">Se guarda en <code>data-comments</code> del bloque.</div>' +
      '<button class="ed-comment-add">Agregar comentario</button>' +
    '</div>';
  document.body.appendChild(commentsPop);

  var commentAction = document.createElement('button');
  commentAction.type = 'button';
  commentAction.className = 'ed-comment-action';
  commentAction.setAttribute('data-editor-ui', '1');
  commentAction.title = 'Comentar este bloque';
  commentAction.textContent = '💬';
  document.body.appendChild(commentAction);

  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var toggle  = $('.ed-toggle', bar);
  var save    = $('.ed-save', bar);
  var commentsBtn = $('.ed-comments', bar);
  var histBtn = $('.ed-history', bar);
  var refresh = $('.ed-refresh', bar);
  var share   = $('.ed-share', bar);
  var cfg     = $('.ed-cfg', bar);
  var mode    = $('.ed-mode', bar);
  var closeOv = $('.ed-close', overlay);
  var hBody   = $('.ed-hbody', overlay);
  var commentsList = $('.ed-comments-list', commentsPop);
  var commentsText = $('.ed-comment-text', commentsPop);
  var commentsAdd  = $('.ed-comment-add', commentsPop);
  var commentsClose = $('.ed-cpop-close', commentsPop);

  var editing = false;
  var dirty = false;
  var snapshot = null;       // foto del contenido editable al entrar en edición
  var lastSavedAt = null;
  var currentCommentTarget = null;
  var TEXT_BLOCK_SELECTOR = '[data-editable],h1,h2,h3,h4,h5,h6,p,li,blockquote,figcaption,dt,dd';

  function isEditableBlock(el) {
    return !!(el && el.matches && el.matches(TEXT_BLOCK_SELECTOR) && !el.closest('[data-editor-ui]') && el.textContent.trim());
  }
  function getEditableBlocks() {
    return Array.prototype.filter.call(document.querySelectorAll(TEXT_BLOCK_SELECTOR), isEditableBlock);
  }
  function closestEditableBlock(node) {
    if (!node) return null;
    var el = node.nodeType === 1 ? node : node.parentElement;
    el = el && el.closest && el.closest(TEXT_BLOCK_SELECTOR);
    return isEditableBlock(el) ? el : null;
  }

  /* ---- Modo de hosting: 'worker' o 'htmlpreview' ---- */
  var hostMode = (location.hostname === 'htmlpreview.github.io') ? 'htmlpreview' : 'worker';

  if (hostMode === 'htmlpreview') {
    var banner = document.createElement('div');
    banner.className = 'ed-banner';
    banner.setAttribute('data-editor-ui', '1');
    banner.textContent = 'Estás abriendo este archivo por htmlpreview. El link recomendado es por el Worker (sin cache).';
    document.body.classList.add('ed-has-banner');
    document.body.insertBefore(banner, document.body.firstChild);
  }

  /* ---- Worker URL ---- */
  function getWorkerUrl() {
    if (hostMode === 'worker') return location.origin;
    var url = localStorage.getItem('workerUrl');
    if (!url) {
      url = prompt('URL del Cloudflare Worker:\n(ej: https://html-commit.tu-subdomain.workers.dev)');
      if (url) { url = url.trim().replace(/\/$/, ''); localStorage.setItem('workerUrl', url); }
    }
    return url;
  }
  cfg.addEventListener('click', function () {
    if (hostMode === 'worker') {
      alert('No hace falta: el Worker URL es el actual (' + location.origin + ').');
      return;
    }
    var cur = localStorage.getItem('workerUrl') || '';
    var nu = prompt('URL del Cloudflare Worker:', cur);
    if (nu !== null) {
      nu = nu.trim().replace(/\/$/, '');
      if (nu) localStorage.setItem('workerUrl', nu);
      else localStorage.removeItem('workerUrl');
    }
  });

  /* ---- Path del archivo ---- */
  function getFilePath() {
    if (hostMode === 'worker') {
      return location.pathname.replace(/^\/+/, '');
    }
    var m = location.href.match(/github\.com\/[^/]+\/[^/]+\/blob\/[^/]+\/(.+?\.html?)(?:[?#&]|$)/i);
    if (m) return decodeURIComponent(m[1]);
    var stored = localStorage.getItem('lastPath') || '';
    var p = prompt('Path del archivo en el repo:', stored);
    if (p) { p = p.trim().replace(/^\/+/, ''); localStorage.setItem('lastPath', p); }
    return p;
  }

  /* ---- Status ---- */
  function clearClasses() { bar.classList.remove('editing', 'dirty', 'saving', 'ok', 'err'); }
  function setStatus(text, cls) {
    mode.textContent = text;
    clearClasses();
    if (editing) bar.classList.add('editing');
    if (dirty) bar.classList.add('dirty');
    if (cls) { clearClasses(); bar.classList.add(cls); }
  }
  function secondsAgo(ts) {
    var s = Math.floor((Date.now() - ts) / 1000);
    if (s < 60) return s + 's';
    if (s < 3600) return Math.floor(s / 60) + ' min';
    if (s < 86400) return Math.floor(s / 3600) + ' h';
    return Math.floor(s / 86400) + ' d';
  }
  function statusLine() {
    if (dirty && editing) return 'editando • sin guardar';
    if (dirty) return 'sin guardar';
    if (editing) return 'editando';
    if (lastSavedAt) return 'guardado hace ' + secondsAgo(lastSavedAt);
    return 'solo lectura';
  }
  function refreshStatus() { setStatus(statusLine()); }
  setInterval(function () { if (!editing && !dirty && lastSavedAt) refreshStatus(); }, 5000);

  /* ---- Dirty por snapshot ----
   * Foto del contenido editable al entrar en edición. En cada input se RECALCULA
   * comparando contra la foto: si el contenido volvió al original, deja de estar
   * sucio. Evita los falsos positivos de marcar dirty a ciegas. ---- */
  function getSnapshot() {
    var parts = [];
    getEditableBlocks().forEach(function (el) {
      parts.push(el.innerHTML);
      parts.push(el.getAttribute('data-comments') || '');
    });
    return parts.join('');
  }
  function recomputeDirty() {
    var now = (snapshot !== null) && (getSnapshot() !== snapshot);
    if (now !== dirty) { dirty = now; refreshStatus(); }
  }
  function hookEditableListeners() {
    getEditableBlocks().forEach(function (el) {
      if (el.dataset.edHooked) return;
      el.dataset.edHooked = '1';
      el.addEventListener('input', function () {
        recomputeDirty();
        renderCommentBadges();
        if (currentCommentTarget) positionCommentAction(currentCommentTarget);
      });
    });
  }

  /* ---- Comentarios embebidos por bloque ---- */
  function ensureSnapshotForCommentMutation() {
    if (snapshot === null) snapshot = getSnapshot();
  }
  function getCommentAuthor() {
    var stored = (localStorage.getItem('htmlDocsCommentAuthor') || '').trim();
    if (stored) return stored;
    var author = prompt('Autor para comentarios:', 'Iña');
    if (author === null) return null;
    author = author.trim() || 'Iña';
    localStorage.setItem('htmlDocsCommentAuthor', author);
    return author;
  }
  function parseComments(el) {
    try {
      var parsed = JSON.parse(el.getAttribute('data-comments') || '[]');
      return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
      console.warn('data-comments inválido', e, el);
      return [];
    }
  }
  function writeComments(el, comments) {
    if (comments.length) el.setAttribute('data-comments', JSON.stringify(comments));
    else el.removeAttribute('data-comments');
    recomputeDirty();
    renderCommentBadges();
    if (currentCommentTarget === el) renderCommentsPopover(el);
  }
  function newCommentId() {
    return 'c_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
  }
  function selectedQuoteWithin(el) {
    var sel = window.getSelection && window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return '';
    var range = sel.getRangeAt(0);
    if (!el.contains(range.commonAncestorContainer)) return '';
    return sel.toString().replace(/\s+/g, ' ').trim().slice(0, 220);
  }
  function activateBlockEditing(el) {
    if (!el) return;
    if (snapshot === null) snapshot = getSnapshot();
    editing = true;
    document.body.classList.add('ed-editing');
    getEditableBlocks().forEach(function (n) {
      if (n === el) n.setAttribute('contenteditable', 'true');
      else n.removeAttribute('contenteditable');
    });
    hookEditableListeners();
    toggle.textContent = 'Listo';
    refreshStatus();
  }
  function setCurrentCommentTarget(el) {
    if (currentCommentTarget && currentCommentTarget !== el) currentCommentTarget.classList.remove('ed-comment-target');
    currentCommentTarget = el || null;
    if (currentCommentTarget) {
      currentCommentTarget.classList.add('ed-comment-target');
      positionCommentAction(currentCommentTarget);
      commentAction.classList.add('show');
      activateBlockEditing(currentCommentTarget);
    } else {
      commentAction.classList.remove('show');
    }
  }
  function hookCommentListeners() {
    getEditableBlocks().forEach(function (el) {
      if (el.dataset.edCommentHooked) return;
      el.dataset.edCommentHooked = '1';
      el.addEventListener('mousedown', function () { setCurrentCommentTarget(el); });
      el.addEventListener('click', function () { setCurrentCommentTarget(el); });
      el.addEventListener('focus', function () { setCurrentCommentTarget(el); });
    });
  }
  function removeCommentBadges() {
    document.querySelectorAll('.ed-comment-badge').forEach(function (n) { n.remove(); });
  }
  function renderCommentBadges() {
    removeCommentBadges();
    getEditableBlocks().forEach(function (el) {
      var comments = parseComments(el);
      if (!comments.length) return;
      var rect = el.getBoundingClientRect();
      if (!rect.width && !rect.height) return;
      var badge = document.createElement('button');
      badge.type = 'button';
      badge.className = 'ed-comment-badge';
      badge.setAttribute('data-editor-ui', '1');
      badge.textContent = '💬 ' + comments.length;
      badge.title = comments.length + ' comentario' + (comments.length === 1 ? '' : 's');
      badge.style.top = (window.scrollY + rect.top) + 'px';
      badge.style.left = (window.scrollX + rect.right + 8) + 'px';
      badge.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        showCommentsPopover(el);
      });
      document.body.appendChild(badge);
    });
  }
  function positionCommentAction(el) {
    if (!el) return;
    var rect = el.getBoundingClientRect();
    if (!rect.width && !rect.height) {
      commentAction.classList.remove('show');
      return;
    }
    var top = window.scrollY + rect.top - 4;
    var left = window.scrollX + rect.left - 44;
    if (left < window.scrollX + 8) left = window.scrollX + rect.right + 8;
    commentAction.style.top = top + 'px';
    commentAction.style.left = left + 'px';
  }
  function positionCommentsPopover(el) {
    var rect = el.getBoundingClientRect();
    var top = window.scrollY + rect.top;
    var left = window.scrollX + rect.right + 14;
    var maxLeft = window.scrollX + document.documentElement.clientWidth - 354;
    if (left > maxLeft) left = Math.max(window.scrollX + 14, maxLeft);
    commentsPop.style.top = Math.max(window.scrollY + 14, top) + 'px';
    commentsPop.style.left = left + 'px';
  }
  function renderCommentsPopover(el) {
    var comments = parseComments(el);
    commentsList.innerHTML = '';
    if (!comments.length) {
      var empty = document.createElement('div');
      empty.className = 'ed-comment-empty';
      empty.textContent = 'Este bloque no tiene comentarios.';
      commentsList.appendChild(empty);
      return;
    }
    comments.forEach(function (comment, idx) {
      var item = document.createElement('div');
      item.className = 'ed-comment';
      var meta = document.createElement('div');
      meta.className = 'meta';
      var date = comment.createdAt ? new Date(comment.createdAt).toLocaleString('es-AR') : '';
      meta.textContent = (comment.author || 'Sin autor') + (date ? ' · ' + date : '');
      item.appendChild(meta);
      if (comment.quote) {
        var quote = document.createElement('div');
        quote.className = 'quote';
        quote.textContent = '“' + comment.quote + '”';
        item.appendChild(quote);
      }
      var text = document.createElement('div');
      text.className = 'text';
      text.textContent = comment.text || '';
      item.appendChild(text);
      var del = document.createElement('button');
      del.type = 'button';
      del.className = 'delete';
      del.textContent = 'Eliminar';
      del.addEventListener('click', function () {
        if (!confirm('¿Eliminar este comentario?')) return;
        ensureSnapshotForCommentMutation();
        var latest = parseComments(el);
        latest.splice(idx, 1);
        writeComments(el, latest);
      });
      item.appendChild(del);
      commentsList.appendChild(item);
    });
  }
  function showCommentsPopover(el) {
    if (!el) return;
    setCurrentCommentTarget(el);
    renderCommentsPopover(el);
    commentsText.value = '';
    positionCommentsPopover(el);
    commentsPop.classList.add('show');
    commentsText.focus();
  }
  function hideCommentsPopover() {
    commentsPop.classList.remove('show');
  }
  commentsBtn.addEventListener('click', function () {
    var target = currentCommentTarget;
    if (!target && document.activeElement) target = closestEditableBlock(document.activeElement);
    if (!target) {
      alert('Clickeá primero el bloque que querés comentar.');
      return;
    }
    showCommentsPopover(target);
  });
  commentAction.addEventListener('click', function (e) {
    e.preventDefault();
    e.stopPropagation();
    if (currentCommentTarget) showCommentsPopover(currentCommentTarget);
  });
  commentsAdd.addEventListener('click', function () {
    if (!currentCommentTarget) return;
    var txt = commentsText.value.trim();
    if (!txt) return;
    var author = getCommentAuthor();
    if (!author) return;
    ensureSnapshotForCommentMutation();
    var comments = parseComments(currentCommentTarget);
    var now = new Date().toISOString();
    comments.push({
      id: newCommentId(),
      author: author,
      createdAt: now,
      updatedAt: now,
      text: txt,
      quote: selectedQuoteWithin(currentCommentTarget),
      replies: []
    });
    commentsText.value = '';
    writeComments(currentCommentTarget, comments);
  });
  commentsClose.addEventListener('click', hideCommentsPopover);

  hookCommentListeners();
  renderCommentBadges();
  window.addEventListener('resize', function () {
    renderCommentBadges();
    if (currentCommentTarget) positionCommentAction(currentCommentTarget);
    if (commentsPop.classList.contains('show') && currentCommentTarget) positionCommentsPopover(currentCommentTarget);
  });

  /* ---- Modo edición ---- */
  toggle.addEventListener('click', function () {
    if (editing) {
      editing = false;
      document.body.classList.remove('ed-editing');
      getEditableBlocks().forEach(function (el) { el.removeAttribute('contenteditable'); });
      toggle.textContent = 'Modo edición';
      refreshStatus();
      return;
    }
    if (currentCommentTarget) {
      activateBlockEditing(currentCommentTarget);
    } else {
      alert('Clickeá el texto que querés editar o comentar.');
    }
  });

  /* ---- Save ---- */
  save.addEventListener('click', async function () {
    var workerUrl = getWorkerUrl();
    if (!workerUrl) return;
    var path = getFilePath();
    if (!path) return;

    var clone = document.documentElement.cloneNode(true);
    clone.querySelectorAll('[data-editor-ui]').forEach(function (n) { n.remove(); });
    clone.querySelectorAll('[contenteditable]').forEach(function (n) { n.removeAttribute('contenteditable'); });
    clone.querySelectorAll('[data-ed-hooked]').forEach(function (n) { n.removeAttribute('data-ed-hooked'); });
    clone.querySelectorAll('[data-ed-comment-hooked]').forEach(function (n) { n.removeAttribute('data-ed-comment-hooked'); });
    clone.querySelectorAll('.ed-comment-target').forEach(function (n) { n.classList.remove('ed-comment-target'); });
    clone.querySelectorAll('base').forEach(function (n) { n.remove(); });
    var cb = clone.querySelector('body');
    if (cb) { cb.classList.remove('ed-editing', 'ed-has-banner'); }
    var html = '<!DOCTYPE html>\n' + clone.outerHTML;

    save.disabled = true;
    setStatus('guardando…', 'saving');

    try {
      var resp = await fetch(workerUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          op: 'save', path: path, html: html,
          message: 'Edición desde el navegador — ' + new Date().toISOString()
        })
      });
      if (resp.ok) {
        editing = false;
        document.body.classList.remove('ed-editing');
        document.querySelectorAll('[contenteditable]').forEach(function (n) { n.removeAttribute('contenteditable'); });
        toggle.textContent = 'Modo edición';
        snapshot = null;
        dirty = false;
        lastSavedAt = Date.now();
        setStatus('✓ guardado', 'ok');
        setTimeout(refreshStatus, 1800);
      } else {
        var text = await resp.text();
        console.error('Worker', resp.status, text);
        setStatus('✗ error ' + resp.status, 'err');
        alert('Error al guardar (' + resp.status + ').\n\n' + text.slice(0, 300));
      }
    } catch (e) {
      console.error(e);
      setStatus('✗ error red', 'err');
      alert('No se pudo conectar al Worker.\n\n' + e.message);
    } finally {
      save.disabled = false;
    }
  });

  /* ---- Reload ---- */
  refresh.addEventListener('click', function () {
    if (dirty && !confirm('Tenés cambios sin guardar. Si recargás, los perdés.\n\n¿Recargar igual?')) return;
    if (hostMode === 'worker') {
      location.reload();
    } else {
      var url = location.href.split('#')[0].replace(/(\?|&)_cb=\d+/g, '');
      var idx = url.toLowerCase().indexOf('.html');
      if (idx > 0) {
        var endHtml = idx + (url.charAt(idx + 4).toLowerCase() === 'l' ? 5 : 4);
        var head = url.slice(0, endHtml);
        var tail = url.slice(endHtml);
        var sep = tail.startsWith('?') ? '&' : '?';
        location.href = head + tail + sep + '_cb=' + Date.now();
      } else {
        var sep2 = url.includes('?') ? '&' : '?';
        location.href = url + sep2 + '_cb=' + Date.now();
      }
    }
  });

  /* ---- Compartir link (sin ?edit=si → vista limpia para terceros) ---- */
  share.addEventListener('click', async function () {
    var workerUrl = getWorkerUrl();
    if (!workerUrl) return;
    var path = getFilePath();
    if (!path) return;
    var shareUrl = workerUrl + '/' + path;
    try {
      await navigator.clipboard.writeText(shareUrl);
      setStatus('✓ link copiado', 'ok');
      setTimeout(refreshStatus, 1800);
    } catch (e) {
      prompt('Link compartible:', shareUrl);
    }
  });

  /* ---- Advertencia al cerrar ---- */
  window.addEventListener('beforeunload', function (e) {
    if (dirty) { e.preventDefault(); e.returnValue = ''; return ''; }
  });

  /* ---- Historial ---- */
  function timeAgo(iso) {
    var d = new Date(iso);
    var s = Math.floor((Date.now() - d.getTime()) / 1000);
    if (s < 60) return 'hace ' + s + 's';
    if (s < 3600) return 'hace ' + Math.floor(s / 60) + ' min';
    if (s < 86400) return 'hace ' + Math.floor(s / 3600) + ' h';
    if (s < 86400 * 7) return 'hace ' + Math.floor(s / 86400) + ' días';
    return d.toLocaleDateString('es-AR', { day: 'numeric', month: 'short', year: 'numeric' });
  }
  function buildPreviewUrl(sha, path) {
    var m = location.href.match(/github\.com\/([^/]+)\/([^/]+)\/blob\//);
    var owner = m ? m[1] : 'ialganaras';
    var repo  = m ? m[2] : 'html';
    return 'https://htmlpreview.github.io/?https://github.com/' + owner + '/' + repo + '/blob/' + sha + '/' + path;
  }
  function renderHistory(commits, path) {
    if (!commits.length) {
      hBody.innerHTML = '<div class="empty">Este archivo todavía no tiene historial.</div>';
      return;
    }
    hBody.innerHTML = '';
    commits.forEach(function (c, idx) {
      var item = document.createElement('div');
      item.className = 'ed-commit' + (idx === 0 ? ' current' : '');
      item.innerHTML =
        '<div class="when">' + timeAgo(c.date) + ' · ' + c.author +
          '<span class="sha">' + c.short + '</span></div>' +
        '<div class="msg"></div>' +
        '<div class="actions">' +
          '<button class="view">👁 Ver</button>' +
          (idx === 0 ? '' : '<button class="restore danger">↩ Restaurar</button>') +
        '</div>';
      item.querySelector('.msg').textContent = c.message.split('\n')[0];
      item.querySelector('.view').addEventListener('click', function () {
        window.open(buildPreviewUrl(c.sha, path), '_blank');
      });
      var rb = item.querySelector('.restore');
      if (rb) {
        rb.addEventListener('click', async function () {
          if (dirty && !confirm('Tenés cambios sin guardar. Restaurar igual?')) return;
          if (!confirm('Restaurar la versión de ' + timeAgo(c.date) + ' (' + c.short + ')?\n\nCrea un commit nuevo con el contenido viejo. El historial se mantiene.')) return;
          rb.disabled = true;
          rb.textContent = 'restaurando…';
          var workerUrl = getWorkerUrl();
          try {
            var resp = await fetch(workerUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                op: 'revert', path: path, sha: c.sha,
                message: 'Restore from ' + c.short + ' — ' + new Date().toISOString()
              })
            });
            if (resp.ok) {
              dirty = false;
              overlay.classList.remove('show');
              setStatus('✓ restaurado, recargando…', 'ok');
              setTimeout(function () { location.reload(); }, 1500);
            } else {
              var t = await resp.text();
              alert('Error al restaurar (' + resp.status + ').\n\n' + t.slice(0, 300));
              rb.disabled = false;
              rb.textContent = '↩ Restaurar';
            }
          } catch (e) {
            alert('No se pudo conectar al Worker.\n\n' + e.message);
            rb.disabled = false;
            rb.textContent = '↩ Restaurar';
          }
        });
      }
      hBody.appendChild(item);
    });
  }
  histBtn.addEventListener('click', async function () {
    var workerUrl = getWorkerUrl();
    if (!workerUrl) return;
    var path = getFilePath();
    if (!path) return;
    overlay.classList.add('show');
    hBody.innerHTML = '<div class="empty">Cargando…</div>';
    try {
      var resp = await fetch(workerUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ op: 'list', path: path, limit: 20 })
      });
      if (!resp.ok) {
        hBody.innerHTML = '<div class="empty">Error al cargar historial (' + resp.status + ').</div>';
        return;
      }
      var commits = await resp.json();
      renderHistory(commits, path);
    } catch (e) {
      hBody.innerHTML = '<div class="empty">No se pudo conectar al Worker.</div>';
    }
  });
  closeOv.addEventListener('click', function () { overlay.classList.remove('show'); });
  overlay.addEventListener('click', function (e) {
    if (e.target === overlay) overlay.classList.remove('show');
  });

  refreshStatus();
})();
