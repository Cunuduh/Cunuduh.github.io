const canvas = document.getElementById("watercolor-background");
const context = canvas.getContext("2d");
const gridWidth = 180;
const gridHeight = 112;
const cellCount = gridWidth * gridHeight;
const automaticSplashInterval = 1500;
const washPigment = { red: 0x9e, green: 0xc9, blue: 0xf3 };
const corePigment = { red: 0x93, green: 0xb6, blue: 0xe0 };
const pooledPigment = { red: 0x56, green: 0x89, blue: 0xbb };

const dye = new Float32Array(cellCount);
const oldDye = new Float32Array(cellCount);
const water = new Float32Array(cellCount);
const oldWater = new Float32Array(cellCount);
const velocityX = new Float32Array(cellCount);
const velocityY = new Float32Array(cellCount);
const oldVelocityX = new Float32Array(cellCount);
const oldVelocityY = new Float32Array(cellCount);
const phase = new Float32Array(cellCount);
const pigmentOwner = new Uint32Array(cellCount);

const simulationCanvas = document.createElement("canvas");
simulationCanvas.width = gridWidth;
simulationCanvas.height = gridHeight;
const simulationContext = simulationCanvas.getContext("2d");
const image = simulationContext.createImageData(gridWidth, gridHeight);

const cellIndex = (x, y) => x + y * gridWidth;
const clamp = (value, minimum, maximum) =>
  Math.max(minimum, Math.min(maximum, value));

let seed = 927341;
let time = 0;
let lastAutomaticSplash = performance.now();
const activeSplashes = [];
let nextSplashId = 1;
let automaticRegionIndex = 0;
let pointerDown = false;
let lastPointerX = 0;
let lastPointerY = 0;
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function random() {
  seed ^= seed << 13;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  return (seed >>> 0) / 4294967295;
}

for (let i = 0; i < cellCount; i++) phase[i] = random() * Math.PI * 2;

// Backtrace through the velocity field and sample between grid cells.
function sample(field, x, y) {
  const boundedX = clamp(x, 0, gridWidth - 1);
  const boundedY = clamp(y, 0, gridHeight - 1);
  const x0 = Math.floor(boundedX);
  const y0 = Math.floor(boundedY);
  const x1 = Math.min(gridWidth - 1, x0 + 1);
  const y1 = Math.min(gridHeight - 1, y0 + 1);
  const tx = boundedX - x0;
  const ty = boundedY - y0;
  const top = field[cellIndex(x0, y0)] * (1 - tx) + field[cellIndex(x1, y0)] * tx;
  const bottom = field[cellIndex(x0, y1)] * (1 - tx) + field[cellIndex(x1, y1)] * tx;
  return top * (1 - ty) + bottom * ty;
}

function diffuse(field, amount) {
  for (let y = 1; y < gridHeight - 1; y++) {
    for (let x = 1; x < gridWidth - 1; x++) {
      const i = cellIndex(x, y);
      const laplacian =
        field[cellIndex(x - 1, y)] + field[cellIndex(x + 1, y)] +
        field[cellIndex(x, y - 1)] + field[cellIndex(x, y + 1)] - field[i] * 4;
      field[i] += laplacian * amount;
    }
  }
}

function simulationStep() {
  time += 0.018;
  oldVelocityX.set(velocityX);
  oldVelocityY.set(velocityY);
  oldDye.set(dye);
  oldWater.set(water);

  for (let y = 1; y < gridHeight - 1; y++) {
    for (let x = 1; x < gridWidth - 1; x++) {
      const i = cellIndex(x, y);
      const noiseStrength = 0.005 * oldWater[i];
      const noiseX = Math.sin(phase[i] + time + x * 0.13 + y * 0.07) * noiseStrength;
      const noiseY = Math.cos(phase[i] * 1.7 - time * 0.8 - x * 0.06 + y * 0.11) * noiseStrength;
      velocityX[i] = (oldVelocityX[i] + noiseX) * 0.982;
      velocityY[i] = (oldVelocityY[i] + noiseY) * 0.982;
    }
  }

  diffuse(velocityX, 0.11);
  diffuse(velocityY, 0.11);

  for (let y = 1; y < gridHeight - 1; y++) {
    for (let x = 1; x < gridWidth - 1; x++) {
      const i = cellIndex(x, y);
      dye[i] = sample(oldDye, x - velocityX[i] * 0.88, y - velocityY[i] * 0.88);
      water[i] = sample(oldWater, x - velocityX[i] * 0.78, y - velocityY[i] * 0.78);
    }
  }

  diffuse(dye, 0.012);
  diffuse(water, 0.052);

  for (let i = 0; i < cellCount; i++) {
    water[i] *= 0.996;
    dye[i] = Math.max(0, dye[i] * 0.9995 - 0.00002);
  }
}

function depositSplash(splash, radius, strength) {
  const { x: gridX, y: gridY, wobble } = splash;

  for (let y = Math.max(1, Math.floor(gridY - radius - 1)); y <= Math.min(gridHeight - 2, Math.ceil(gridY + radius + 1)); y++) {
    for (let x = Math.max(1, Math.floor(gridX - radius - 1)); x <= Math.min(gridWidth - 2, Math.ceil(gridX + radius + 1)); x++) {
      const dx = x - gridX;
      const dy = y - gridY;
      const distance = Math.hypot(dx, dy) + 0.001;
      const angle = Math.atan2(dy, dx);
      const localRadius = radius * (1 + 0.1 * Math.sin(angle * 5 + wobble) + 0.04 * Math.sin(angle * 9 - wobble));

      if (distance > localRadius) continue;

      const normalizedDistance = distance / localRadius;
      const falloff = Math.exp(-(distance * distance) / (radius * radius * 0.34));
      const tideLine = Math.exp(-Math.pow((normalizedDistance - 0.82) / 0.105, 2));
      const i = cellIndex(x, y);
      const pigmentDeposit = (falloff * 0.72 + tideLine * 0.48) * strength;
      dye[i] = Math.min(1.7, dye[i] + pigmentDeposit);
      pigmentOwner[i] = splash.id;
      water[i] = Math.min(1.7, water[i] + falloff * strength * 1.35);
      const outward = (falloff + tideLine * 0.35) * strength * 0.18;
      velocityX[i] += (dx / distance) * outward + (random() - 0.5) * 0.014;
      velocityY[i] += (dy / distance) * outward + (random() - 0.5) * 0.014;
    }
  }
}

function queueSplash(gridX, gridY) {
  const radius = 18 + random() * 8;
  const splash = {
    id: nextSplashId++,
    x: gridX,
    y: gridY,
    age: 0,
    duration: 0.42,
    fadeDelay: 1.2,
    lifespan: 9 + radius * 0.22,
    radius,
    wobble: random() * Math.PI * 2
  };

  if (reducedMotion) {
    depositSplash(splash, splash.radius, 1.05);
    render();
    return;
  }

  activeSplashes.push(splash);
}

function expandSplashes(deltaTime) {
  for (let i = activeSplashes.length - 1; i >= 0; i--) {
    const splash = activeSplashes[i];
    splash.age += deltaTime;

    if (splash.age <= splash.duration) {
      const progress = splash.age / splash.duration;
      const easedProgress = 1 - Math.pow(1 - progress, 3);
      depositSplash(splash, Math.max(0.5, splash.radius * easedProgress), 0.115);
    } else if (splash.age >= splash.fadeDelay) {
      erodeSplash(splash);
    }

    if (splash.age >= splash.lifespan) activeSplashes.splice(i, 1);
  }
}

// Expanding the erosion radius makes the centre clear before the perimeter.
function erodeSplash(splash) {
  const fadeDuration = splash.lifespan - splash.fadeDelay;
  const fadeProgress = clamp((splash.age - splash.fadeDelay) / fadeDuration, 0, 1);
  const erosionRadius = splash.radius * fadeProgress;
  const warpedExtent = erosionRadius * 1.4;
  const minimumX = Math.max(1, Math.floor(splash.x - warpedExtent));
  const maximumX = Math.min(gridWidth - 2, Math.ceil(splash.x + warpedExtent));
  const minimumY = Math.max(1, Math.floor(splash.y - warpedExtent));
  const maximumY = Math.min(gridHeight - 2, Math.ceil(splash.y + warpedExtent));

  for (let y = minimumY; y <= maximumY; y++) {
    for (let x = minimumX; x <= maximumX; x++) {
      const i = cellIndex(x, y);
      if (pigmentOwner[i] !== splash.id) continue;
      const dx = x - splash.x;
      const dy = y - splash.y;
      const distance = Math.hypot(dx, dy);
      const angle = Math.atan2(dy, dx);
      const frontWarp =
        1 +
        Math.sin(angle * 3 + splash.wobble) * 0.2 +
        Math.sin(angle * 7 - splash.wobble * 1.4) * 0.11 +
        Math.sin(phase[i] + splash.wobble) * 0.08;
      const localErosionRadius = erosionRadius * frontWarp;
      if (distance > localErosionRadius) continue;
      const proximityToCentre = 1 - distance / Math.max(localErosionRadius, 0.001);
      const paperVariation = 0.94 + Math.sin(phase[i]) * 0.06;
      const fadeStrength = (0.0045 + proximityToCentre * 0.015) * paperVariation;
      dye[i] *= 1 - fadeStrength;
    }
  }
}

function resizeCanvas() {
  const scale = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(window.innerWidth * scale);
  canvas.height = Math.round(window.innerHeight * scale);
}

function simulationViewport() {
  const canvasRatio = canvas.width / canvas.height;
  const simulationRatio = gridWidth / gridHeight;

  if (canvasRatio > simulationRatio) {
    const height = gridWidth / canvasRatio;
    return { x: 0, y: (gridHeight - height) / 2, width: gridWidth, height };
  }

  const width = gridHeight * canvasRatio;
  return { x: (gridWidth - width) / 2, y: 0, width, height: gridHeight };
}

function render() {
  const pixels = image.data;

  for (let i = 0; i < cellCount; i++) {
    const amount = clamp(dye[i], 0, 1.3);
    const wash = clamp(amount * 0.72 + water[i] * 0.06, 0, 1);
    const core = clamp((amount - 0.35) / 0.7, 0, 1);
    const coreMix = core * core;
    const alpha = clamp(wash * 0.42 + core * 0.4, 0, 0.84);
    const offset = i * 4;
    const x = i % gridWidth;
    const y = Math.floor(i / gridWidth);
    let localPeak = 0;

    if (x > 0 && x < gridWidth - 1 && y > 0 && y < gridHeight - 1) {
      const neighbourAverage = (
        dye[cellIndex(x - 1, y)] + dye[cellIndex(x + 1, y)] +
        dye[cellIndex(x, y - 1)] + dye[cellIndex(x, y + 1)]
      ) * 0.25;
      localPeak = Math.max(0, amount - neighbourAverage);
    }

    const pooling = clamp(localPeak * 2.2 + amount * water[i] * 0.08, 0, 0.42);
    const baseRed = washPigment.red * (1 - coreMix) + corePigment.red * coreMix;
    const baseGreen = washPigment.green * (1 - coreMix) + corePigment.green * coreMix;
    const baseBlue = washPigment.blue * (1 - coreMix) + corePigment.blue * coreMix;
    const red = baseRed * (1 - pooling) + pooledPigment.red * pooling;
    const green = baseGreen * (1 - pooling) + pooledPigment.green * pooling;
    const blue = baseBlue * (1 - pooling) + pooledPigment.blue * pooling;
    pixels[offset] = Math.round(red);
    pixels[offset + 1] = Math.round(green);
    pixels[offset + 2] = Math.round(blue);
    pixels[offset + 3] = Math.round(alpha * 255);
  }

  simulationContext.putImageData(image, 0, 0);
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  const viewport = simulationViewport();
  context.drawImage(
    simulationCanvas,
    viewport.x,
    viewport.y,
    viewport.width,
    viewport.height,
    0,
    0,
    canvas.width,
    canvas.height
  );
}

function canvasPositionToSimulation(clientX, clientY) {
  const bounds = canvas.getBoundingClientRect();
  const viewport = simulationViewport();
  return {
    x: viewport.x + ((clientX - bounds.left) / bounds.width) * viewport.width,
    y: viewport.y + ((clientY - bounds.top) / bounds.height) * viewport.height
  };
}

function pointerPosition(event) {
  return canvasPositionToSimulation(event.clientX, event.clientY);
}

canvas.addEventListener("pointerdown", event => {
  pointerDown = true;
  canvas.setPointerCapture?.(event.pointerId);
  const point = pointerPosition(event);
  lastPointerX = point.x;
  lastPointerY = point.y;
  queueSplash(point.x, point.y);
});

canvas.addEventListener("pointermove", event => {
  if (!pointerDown) return;
  const point = pointerPosition(event);
  const dx = point.x - lastPointerX;
  const dy = point.y - lastPointerY;

  if (dx * dx + dy * dy >= 16) {
    queueSplash(point.x, point.y);
    lastPointerX = point.x;
    lastPointerY = point.y;
  }
});

canvas.addEventListener("pointerup", () => { pointerDown = false; });
canvas.addEventListener("pointercancel", () => { pointerDown = false; });

window.addEventListener("resize", () => {
  resizeCanvas();
  render();
});

function addRandomSplash() {
  const receipt = document.querySelector(".receipt-shell").getBoundingClientRect();
  const canvasBounds = canvas.getBoundingClientRect();
  const inset = 8;
  const regions = [
    { left: inset, top: inset, right: receipt.left - inset, bottom: canvasBounds.height - inset },
    { left: receipt.right + inset, top: inset, right: canvasBounds.width - inset, bottom: canvasBounds.height - inset },
    { left: inset, top: inset, right: canvasBounds.width - inset, bottom: receipt.top - inset },
    { left: inset, top: receipt.bottom + inset, right: canvasBounds.width - inset, bottom: canvasBounds.height - inset }
  ].filter(region => region.right - region.left >= 24 && region.bottom - region.top >= 24);

  if (regions.length === 0) return;

  const region = regions[automaticRegionIndex % regions.length];
  automaticRegionIndex++;
  const clientX = region.left + random() * (region.right - region.left);
  const clientY = region.top + random() * (region.bottom - region.top);
  const point = canvasPositionToSimulation(clientX, clientY);
  queueSplash(point.x, point.y);
}

function loop(timestamp) {
  if (timestamp - lastAutomaticSplash >= automaticSplashInterval) {
    addRandomSplash();
    lastAutomaticSplash = timestamp;
  }

  expandSplashes(0.018);
  simulationStep();
  render();
  requestAnimationFrame(loop);
}

resizeCanvas();
render();

if (!reducedMotion) {
  requestAnimationFrame(loop);
}
