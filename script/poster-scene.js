export function createPosterScene({ stage, sheet, select, initialIndex = 0 }) {
  const wash = sheet.querySelector('.poster-wash');
  const context = wash?.getContext('2d');
  const events = new AbortController();
  let disposed = false;
  let raf = 0;
  let targetX = 0;
  let targetY = 0;
  let lastWash = 0;
  let washWidth = 0;
  let washHeight = 0;

  function render() {
    raf = 0;
    sheet.style.setProperty('--poster-tilt-x', `${targetX.toFixed(2)}deg`);
    sheet.style.setProperty('--poster-tilt-y', `${targetY.toFixed(2)}deg`);
  }
  function schedule() {
    if (!raf) raf = requestAnimationFrame(render);
  }
  function move(event) {
    if (event.pointerType === 'touch') return;
    const bounds = stage.getBoundingClientRect();
    const x = (event.clientX - bounds.left) / bounds.width * 2 - 1;
    const y = (event.clientY - bounds.top) / bounds.height * 2 - 1;
    targetX = Math.max(-4, Math.min(4, -y * 4));
    targetY = Math.max(-6, Math.min(6, x * 6));
    schedule();
  }
  function resetTilt() {
    targetX = 0;
    targetY = 0;
    schedule();
  }
  function paintWatercolour(source) {
    const now = performance.now();
    if (disposed || !context || !source?.width || !source?.height || now - lastWash < 1000 / 12) return;
    lastWash = now;
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    const width = Math.max(1, Math.floor(sheet.offsetWidth * dpr));
    const height = Math.max(1, Math.floor(sheet.offsetHeight * dpr));
    if (width !== washWidth || height !== washHeight) {
      wash.width = washWidth = width;
      wash.height = washHeight = height;
    }
    const washTop = Math.ceil(height / 2);
    const destinationHeight = height - washTop;
    const sourceRatio = source.width / source.height;
    const targetRatio = width / destinationHeight;
    let sx = 0; let sy = 0; let sw = source.width; let sh = source.height;
    if (sourceRatio > targetRatio) { sw = source.height * targetRatio; sx = (source.width - sw) / 2; }
    else { sh = source.width / targetRatio; sy = (source.height - sh) / 2; }
    try {
      context.clearRect(0, 0, width, height);
      context.globalAlpha = .35;
      context.drawImage(source, sx, sy, sw, sh, 0, washTop, width, destinationHeight);
      context.globalAlpha = 1;
      sheet.classList.add('poster-live-wash');
    } catch {
      context.globalAlpha = 1;
    }
  }
  stage.addEventListener('pointermove', move, { signal: events.signal });
  stage.addEventListener('pointerleave', resetTilt, { signal: events.signal });
  window.addEventListener('blur', resetTilt, { signal: events.signal });
  render();
  select?.(initialIndex);
  return {
    paintWatercolour,
    select: index => select?.(index),
    dispose() {
      if (disposed) return;
      disposed = true;
      cancelAnimationFrame(raf);
      events.abort();
      sheet.style.removeProperty('--poster-tilt-x');
      sheet.style.removeProperty('--poster-tilt-y');
    },
  };
}
