(() => {
  const games = window.archiveData?.games;
  const dialog = document.querySelector('#archive-dialog');
  if (!games?.length || !dialog?.showModal) return;
  const inner = dialog.querySelector('.archive-dialog-inner');
  const close = dialog.querySelector('[data-archive-close]');
  let opener; let poster = null; let version = 0; let openGeneration = 0;

  function buildPoster() {
    inner.innerHTML = `<div class="poster-stage" tabindex="0" aria-label="Interactive Godot Games tracklist poster">
      <article class="poster-sheet" aria-labelledby="archive-dialog-title">
        <canvas class="poster-wash" aria-hidden="true"></canvas>
        <div class="poster-art"><img alt="" decoding="async"></div>
        <header class="poster-heading"><h2 id="archive-dialog-title">GODOT GAMES</h2><p class="poster-subtitle">Earlier experiments · Glae Alejo</p></header>
        <p class="poster-status" role="status"></p>
        <section class="poster-track-section" aria-label="Godot game links"><p class="poster-section-label">TRACKLIST</p><ol class="poster-tracks"></ol></section>
        <footer class="poster-footer"><span class="poster-track-count"></span><span>GLAE ALEJO</span></footer>
      </article></div>`;
    const stage = inner.querySelector('.poster-stage'); const sheet = inner.querySelector('.poster-sheet');
    const list = inner.querySelector('.poster-tracks'); const art = inner.querySelector('.poster-art img');
    const status = inner.querySelector('.poster-status');
    inner.querySelector('.poster-track-count').textContent = `${String(games.length).padStart(2, '0')} TRACKS`;
    games.forEach((game, index) => {
      const li = document.createElement('li'); const anchor = document.createElement('a');
      anchor.href = game.link; anchor.target = '_blank'; anchor.rel = 'noreferrer'; anchor.dataset.index = String(index);
      anchor.textContent = game.title;
      anchor.addEventListener('pointerenter', () => select(index)); anchor.addEventListener('focus', () => select(index));
      anchor.addEventListener('click', () => select(index)); li.append(anchor); list.append(li);
    });
    function select(index) {
      const game = games[index]; if (!game) return; const ticket = ++version;
      [...list.querySelectorAll('a')].forEach((a, i) => a.setAttribute('aria-current', String(i === index)));
      art.alt = ''; art.removeAttribute('src'); status.textContent = '';
      const next = new Image(); next.src = game.image;
      next.decode().then(() => {
        if (ticket !== version) return;
        art.src = game.image; art.alt = `${game.title} cover`;
      }).catch(() => {
        if (ticket === version) status.textContent = 'Preview unavailable. The game link still works.';
      });
    }
    select(0); return { stage, sheet, select };
  }
  async function open(index = 0, source = document.activeElement) {
    const generation = ++openGeneration;
    poster?.dispose?.(); poster = null;
    opener = source; const nodes = buildPoster(); nodes.select(index);
    if (!dialog.open) dialog.showModal(); close.focus();
    try { const module = await import('./poster-scene.js'); if (!dialog.open || generation !== openGeneration) return;
      poster = module.createPosterScene({ ...nodes, initialIndex: index });
      window.paintPosterWatercolour = sourceCanvas => poster?.paintWatercolour(sourceCanvas); nodes.select(index);
    } catch (error) { console.warn('[archive] 3D poster unavailable; using native poster layout.', error); }
  }
  function closePoster() { openGeneration += 1; window.paintPosterWatercolour = undefined; poster?.dispose?.(); poster = null; dialog.close(); }
  close.addEventListener('click', closePoster);
  dialog.addEventListener('close', () => { openGeneration += 1; window.paintPosterWatercolour = undefined; poster?.dispose?.(); poster = null; opener?.focus(); });
  dialog.addEventListener('click', event => {
    event.stopPropagation();
    if (event.target === dialog || event.target.classList.contains('poster-stage')) closePoster();
  });
  document.querySelectorAll('#games .archive-fallback a').forEach((anchor, index) => anchor.addEventListener('click', event => {
    if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return; event.preventDefault(); open(index, anchor);
  }));
  document.addEventListener('cd-open-games', () => open()); document.body.classList.add('archive-enhanced');
})();
