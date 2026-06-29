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

  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var toggle  = $('.ed-toggle', bar);
  var save    = $('.ed-save', bar);
  var histBtn = $('.ed-history', bar);
  var refresh = $('.ed-refresh', bar);
  var share   = $('.ed-share', bar);
  var cfg     = $('.ed-cfg', bar);
  var mode    = $('.ed-mode', bar);
  var closeOv = $('.ed-close', overlay);
  var hBody   = $('.ed-hbody', overlay);

  var editing = false;
  var dirty = false;
  var snapshot = null;       // foto del contenido editable al entrar en edición
  var lastSavedAt = null;

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
    document.querySelectorAll('[data-editable]').forEach(function (el) {
      parts.push(el.innerHTML);
    });
    return parts.join('');
  }
  function recomputeDirty() {
    var now = (snapshot !== null) && (getSnapshot() !== snapshot);
    if (now !== dirty) { dirty = now; refreshStatus(); }
  }
  function hookEditableListeners() {
    document.querySelectorAll('[data-editable]').forEach(function (el) {
      if (el.dataset.edHooked) return;
      el.dataset.edHooked = '1';
      el.addEventListener('input', recomputeDirty);
    });
  }

  /* ---- Modo edición ---- */
  toggle.addEventListener('click', function () {
    editing = !editing;
    document.body.classList.toggle('ed-editing', editing);
    document.querySelectorAll('[data-editable]').forEach(function (el) {
      if (editing) el.setAttribute('contenteditable', 'true');
      else el.removeAttribute('contenteditable');
    });
    if (editing) {
      snapshot = getSnapshot();   // foto base para comparar
      hookEditableListeners();
    }
    toggle.textContent = editing ? 'Listo' : 'Modo edición';
    refreshStatus();
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
