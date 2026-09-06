const dropButton = document.querySelector('[data-cd-drop]');
const reduced = matchMedia('(prefers-reduced-motion: reduce)');
document.body.classList.add('cd-enabled');
let instance;
let loading;

dropButton?.addEventListener('click', async () => {
  dropButton.disabled = true;
  try {
    if (!instance) {
      loading ||= import('../vendor/three/three.module.min.js').then(buildCD);
      instance = await loading;
    }
    instance.drop();
  } catch (error) {
    console.error('CD renderer unavailable', error);
    loading = null;
    document.dispatchEvent(new Event('cd-open-games'));
  } finally {
    dropButton.disabled = false;
  }
});

async function buildCD(T) {
  const renderer = new T.WebGLRenderer({ alpha: true, antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setClearColor(0x000000, 0);
  renderer.toneMapping = T.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;
  renderer.shadowMap.enabled = true;
  // The receiver shader below adds a contact-tight, blocker-distance-aware
  // penumbra for the broad room key. The source map remains a packed depth map
  // so the custom comparison does not depend on VSM's constant blur radius.
  renderer.shadowMap.type = T.BasicShadowMap;
  const canvas = renderer.domElement;
  canvas.className = 'cd-canvas';
  canvas.hidden = true;
  canvas.setAttribute('aria-hidden', 'true');
  document.body.append(canvas);

  // Reflected light needs to blend with the page behind the CD, not with the
  // opaque/transparent contents of the CD renderer itself.
  const bounceRenderer = new T.WebGLRenderer({ alpha: true, antialias: true });
  bounceRenderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  bounceRenderer.setClearColor(0x000000, 0);
  const bounceCanvas = bounceRenderer.domElement;
  bounceCanvas.className = 'cd-light-canvas';
  bounceCanvas.hidden = true;
  bounceCanvas.setAttribute('aria-hidden', 'true');
  document.body.append(bounceCanvas);

  const controls = document.createElement('div');
  controls.className = 'cd-controls';
  controls.hidden = true;
  controls.setAttribute('role', 'toolbar');
  controls.setAttribute('aria-label', 'CD controls. Drag the clear centre to move; drag the outer disc to turn.');
  document.body.append(controls);
  const scene = new T.Scene();
  const camera = new T.PerspectiveCamera(35, 1, .1, 30);
  camera.position.z = 8;
  const bounceScene = new T.Scene();
  const bounceCamera = camera.clone();

  // Fixed room reflections are sampled in world space, never painted onto the disc.
  const room = new T.Scene();
  room.background = new T.Color(0x555d63);
  const panels = [
    [-4, 3, 4, 3, 7, 0xffffff, 5],
    [5, 1, 2, 1.5, 6, 0xddeaff, 3],
    [0, -4, -3, 7, 2, 0xf5eee3, 2],
    [-3, 2, -5, 3, 5, 0xffffff, 4],
  ];
  for (const [x, y, z, w, h, color, intensity] of panels) {
    const panel = new T.Mesh(new T.PlaneGeometry(w, h), new T.MeshBasicMaterial({ color: new T.Color(color).multiplyScalar(intensity), side: T.DoubleSide }));
    panel.position.set(x, y, z);
    panel.lookAt(0, 0, 0);
    room.add(panel);
  }
  const surface = document.createElement('canvas');
  surface.width = surface.height = 2048;
  const ctx = surface.getContext('2d');
  ctx.fillStyle = '#aeb4b5'; ctx.fillRect(0, 0, 2048, 2048);
  try {
    const paper = new Image(); paper.src = 'img/watercolour-paper-tile.webp';
    await paper.decode();
    ctx.drawImage(paper, 0, 0, 2048, 2048);
  } catch { /* The neutral desk still supplies a reflection if the texture fails. */ }
  for (const [x, y, r] of [[300, 520, 330], [1730, 1040, 460], [600, 1760, 240]]) {
    const wash = ctx.createRadialGradient(x, y, r * .45, x, y, r);
    wash.addColorStop(0, '#7fa7c520'); wash.addColorStop(.85, '#709ec04a'); wash.addColorStop(1, '#709ec000');
    ctx.fillStyle = wash; ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }
  ctx.save(); ctx.translate(650, 80); ctx.rotate(.026);
  ctx.fillStyle = '#d7d8d3'; ctx.fillRect(0, 0, 760, 1900);
  ctx.fillStyle = '#202020'; ctx.font = 'italic 100px serif'; ctx.fillText('glae.a', 180, 160);
  ctx.font = '22px monospace';
  let lineY = 230;
  for (const element of document.querySelectorAll('main h2, main p, #games .archive-fallback a')) {
    if (lineY > 1820) break;
    const words = element.textContent.trim().split(/\s+/); let line = '';
    for (const word of words) {
      if ((line + word).length > 46) { ctx.fillText(line, 40, lineY); lineY += 29; line = ''; }
      line += word + ' ';
      if (lineY > 1820) break;
    }
    ctx.fillText(line, 40, lineY); lineY += 48;
  }
  ctx.restore();
  const surfaceMap = new T.CanvasTexture(surface); surfaceMap.colorSpace = T.SRGBColorSpace;
  const desk = new T.Mesh(new T.PlaneGeometry(14, 14), new T.MeshBasicMaterial({ map: surfaceMap, side: T.DoubleSide }));
  desk.position.z = -3; room.add(desk);
  const ceiling = new T.Mesh(new T.PlaneGeometry(18, 18), new T.MeshBasicMaterial({ color: 0x9caaa9, side: T.DoubleSide }));
  ceiling.position.z = 7; room.add(ceiling);
  for (const x of [-4, 0, 4]) {
    const beam = new T.Mesh(new T.BoxGeometry(.12, 18, .12), new T.MeshBasicMaterial({ color: 0x465354 }));
    beam.position.set(x, 0, 6.8); room.add(beam);
  }
  const pmrem = new T.PMREMGenerator(renderer);
  // PMREM's atlas is 3x4 faces. Only request the 1024-face version when the
  // hardware can hold its 4096px atlas; smaller devices retain a useful
  // reflection without exceeding MAX_TEXTURE_SIZE.
  const maxTextureSize = renderer.capabilities.maxTextureSize;
  const environmentSize = maxTextureSize >= 4096 ? 1024 : maxTextureSize >= 2048 ? 512 : 256;
  const environment = pmrem.fromScene(room, 0, .1, 100, { size: environmentSize });
  scene.environment = environment.texture;
  pmrem.dispose();
  room.traverse(item => { item.geometry?.dispose(); item.material?.dispose(); });
  surfaceMap.dispose();

  scene.add(new T.HemisphereLight(0xe5edff, 0x68625a, 1.5));
  const light = new T.DirectionalLight(0xffffff, 3);
  light.position.set(-3, 4, 8);
  light.castShadow = true;
  light.shadow.mapSize.set(environmentSize >= 1024 ? 2048 : 1024, environmentSize >= 1024 ? 2048 : 1024);
  Object.assign(light.shadow.camera, { left: -5, right: 5, top: 5, bottom: -5, near: .1, far: 25 });
  light.shadow.bias = -.0001;
  light.shadow.normalBias = .012;
  scene.add(light);

  const anchor = new T.Group();
  const disc = new T.Group();
  anchor.add(disc);
  scene.add(anchor);
  const bounceAnchor = new T.Group();
  bounceScene.add(bounceAnchor);
  const radius = 1.8;
  const hole = .225;
  const thickness = .036;
  const ring = (inner, outer) => new T.RingGeometry(inner, outer, 192);
  const metal = new T.MeshPhysicalMaterial({ color: 0xc9ccca, metalness: 1, roughness: .075, clearcoat: 1, clearcoatRoughness: .035, envMapIntensity: 1.25 });
  const paperWhite = new T.MeshPhysicalMaterial({ color: 0xf3f1e9, metalness: 0, roughness: .65, clearcoat: .12, clearcoatRoughness: .5, envMapIntensity: .18 });
  const front = new T.Mesh(ring(.57, radius), paperWhite);
  front.position.z = thickness / 2;
  disc.add(front);
  const underside = new T.MeshPhysicalMaterial({ color: 0xe1e0d8, metalness: 1, roughness: .045, clearcoat: 1, clearcoatRoughness: .025, iridescence: .45, iridescenceIOR: 1.5, iridescenceThicknessRange: [180, 720], envMapIntensity: 1.45 });
  // Approximate diffraction by concentric 1.6-micrometre CD tracks under
  // the fixed key light; bands depend on angle, never time or cursor speed.
  underside.onBeforeCompile = shader => {
    const varyings = 'varying vec3 cdWorld; varying vec3 cdRadial;\n';
    shader.vertexShader = varyings + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\ncdWorld = (modelMatrix * vec4(position, 1.0)).xyz; cdRadial = mat3(modelMatrix) * vec3(position.xy, 0.0);');
    shader.fragmentShader = varyings + shader.fragmentShader;
    shader.fragmentShader = shader.fragmentShader.replace('#include <opaque_fragment>', `
      vec3 cdView = normalize(cameraPosition - cdWorld);
      vec3 cdSpectrum = vec3(0.0);
      for (int source = 0; source < 2; source++) {
        vec3 cdLight = source == 0 ? normalize(vec3(-3.0, 4.0, 8.0)) : normalize(vec3(5.0, 1.0, 2.0));
        float cdPath = abs(dot(cdView + cdLight, normalize(cdRadial))) * 1600.0;
        for (int order = 1; order <= 3; order++) {
          float wavelength = cdPath / float(order);
          vec3 band = (vec3(625.0, 535.0, 450.0) - wavelength) / vec3(44.0, 36.0, 32.0);
          cdSpectrum += exp(-band * band) * (source == 0 ? 1.0 : 0.38) / float(order);
        }
      }
      outgoingLight += cdSpectrum * 0.48;
      #include <opaque_fragment>
    `);
  };
  const back = new T.Mesh(ring(.57, radius), underside);
  back.rotation.y = Math.PI;
  back.position.z = -thickness / 2;
  disc.add(back);

  const grooves = document.createElement('canvas');
  grooves.width = grooves.height = 1024;
  const grain = grooves.getContext('2d');
  grain.fillStyle = '#999'; grain.fillRect(0, 0, 1024, 1024);
  for (let r = 160; r < 510; r += .8) {
    grain.strokeStyle = `rgba(255,255,255,${.12 + .1 * Math.sin(r * 7)})`;
    grain.lineWidth = .45; grain.beginPath(); grain.arc(512, 512, r, 0, Math.PI * 2); grain.stroke();
  }
  const grooveMap = new T.CanvasTexture(grooves);
  underside.bumpMap = grooveMap;
  underside.bumpScale = .0003;
  underside.iridescenceThicknessMap = grooveMap;

  const plastic = new T.MeshPhysicalMaterial({ color: 0xc8d0d2, metalness: .05, roughness: .12, transparent: true, opacity: .42, clearcoat: 1, side: T.DoubleSide, depthWrite: false });
  for (const z of [-thickness / 2, thickness / 2]) {
    const hub = new T.Mesh(ring(hole, .58), plastic);
    hub.position.z = z;
    disc.add(hub);
  }
  for (const r of [hole, .51, radius]) {
    const edge = new T.Mesh(new T.TorusGeometry(r, r === radius ? .017 : .009, 8, 192), r === radius ? metal : plastic);
    disc.add(edge);
  }

  const label = document.createElement('canvas');
  label.width = label.height = 2048;
  const ink = label.getContext('2d');
  ink.fillStyle = '#202020'; ink.font = '20px sans-serif';
  const rimText = 'GLAE ALEJO  •  GODOT GAMES  •  FOUR EARLY EXPERIMENTS  •  INTERACTIVE ARCHIVE  •  ';
  [...rimText.repeat(2)].forEach((letter, i) => {
    const angle = i / (rimText.length * 2) * Math.PI * 2;
    ink.save(); ink.translate(1024, 1024); ink.rotate(angle); ink.fillText(letter, 0, -956); ink.restore();
  });
  const labelArtwork = { left: 440, top: 1365, right: 1608, bottom: 1700 };
  ink.fillStyle = '#6f9fc2'; ink.fillRect(labelArtwork.left, labelArtwork.top, labelArtwork.right - labelArtwork.left, labelArtwork.bottom - labelArtwork.top);
  ink.fillStyle = '#e1e4e3'; ink.font = 'bold 100px sans-serif'; ink.fillText('GODOT GAMES', 490, 1455);
  ink.font = 'bold 43px monospace';
  ink.fillText('GLAE ALEJO / VOL. 01', 490, 1500);
  ink.fillText('04 TRACKS · MADE IN GODOT', 490, 1543);
  ink.font = 'bold 60px sans-serif'; ink.fillText('PRESS LABEL', 490, 1610);
  ink.fillText('TO OPEN TRACKS', 490, 1678);
  for (let x = 1450; x < 1580; x += 7) ink.fillRect(x, 1430, 1 + (x % 4), 230);
  const labelMap = new T.CanvasTexture(label);
  labelMap.colorSpace = T.SRGBColorSpace;
  labelMap.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  const print = new T.Mesh(ring(.58, radius - .01), new T.MeshStandardMaterial({ map: labelMap, transparent: true, roughness: .64, metalness: .05, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1 }));
  print.position.z = .021;
  disc.add(print);
  // Transparent hub materials otherwise render as opaque in the shadow map.
  disc.traverse(item => { if (item.isMesh && item.material !== plastic) item.castShadow = true; });
  print.castShadow = false;
  const shadowMaterial = new T.ShadowMaterial({ color: 0x202020, opacity: .28 });
  shadowMaterial.name = 'cd-key-shadow-pcss';
  const shadowDiscCenter = new T.Vector3();
  const shadowDiscBasisX = new T.Vector3(1, 0, 0);
  const shadowDiscBasisY = new T.Vector3(0, 1, 0);
  const shadowDiscNormal = new T.Vector3(0, 0, 1);
  const shadowKeyDirection = new T.Vector3(-3, 4, 8).normalize();
  const shadowDiscUniforms = {
    center: { value: shadowDiscCenter },
    basisX: { value: shadowDiscBasisX },
    basisY: { value: shadowDiscBasisY },
    normal: { value: shadowDiscNormal },
    // Keep the radial shader coordinate in the disc's native world units;
    // the receiver and disc are both scaled by the anchor.
    radius: { value: anchor.scale.x },
    keyDirection: { value: shadowKeyDirection },
  };
  shadowMaterial.onBeforeCompile = shader => {
    shader.uniforms.cdDiscCenter = shadowDiscUniforms.center;
    shader.uniforms.cdDiscBasisX = shadowDiscUniforms.basisX;
    shader.uniforms.cdDiscBasisY = shadowDiscUniforms.basisY;
    shader.uniforms.cdDiscNormal = shadowDiscUniforms.normal;
    shader.uniforms.cdDiscRadius = shadowDiscUniforms.radius;
    shader.uniforms.cdKeyDirection = shadowDiscUniforms.keyDirection;
    shader.vertexShader = `varying vec3 cdShadowWorld;\n${shader.vertexShader}`;
    const shadowWorldAssignment = 'cdShadowWorld = (modelMatrix * vec4(position, 1.0)).xyz;';
    if (shader.vertexShader.includes('#include <begin_vertex>')) {
      shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>\n${shadowWorldAssignment}`);
    } else {
      shader.vertexShader = shader.vertexShader.replace('#include <project_vertex>', `${shadowWorldAssignment}\n#include <project_vertex>`);
    }
    const basePars = T.ShaderChunk.shadowmap_pars_fragment.replace('float getShadow(', 'float getShadowBase(');
    const pcss = `${basePars}
      #ifdef USE_SHADOWMAP
      float cdPcssShadow(sampler2D shadowMap, vec2 shadowMapSize, float shadowIntensity, float shadowBias, float shadowRadius, vec4 shadowCoord) {
        shadowCoord.xyz /= shadowCoord.w;
        shadowCoord.z += shadowBias;
        bool inside = shadowCoord.x >= 0.0 && shadowCoord.x <= 1.0 && shadowCoord.y >= 0.0 && shadowCoord.y <= 1.0 && shadowCoord.z <= 1.0;
        if (!inside) return 1.0;
        vec2 texel = 1.0 / shadowMapSize;
        float receiver = shadowCoord.z;
        float blockerSum = 0.0;
        float blockers = 0.0;
        const float golden = 2.39996323;
        const int BLOCKER_SAMPLES = 64;
        const int FILTER_SAMPLES = 128;
        // Keep the high sample budget smooth on modern desktop hardware.
        for (int i = 0; i < BLOCKER_SAMPLES; i++) {
          float fi = float(i) + .5;
          float radius = 24.0 * sqrt(float(i) / float(BLOCKER_SAMPLES - 1));
          vec2 offset = vec2(cos(fi * golden), sin(fi * golden)) * radius * texel;
          float sampleDepth = unpackRGBAToDepth(texture2D(shadowMap, shadowCoord.xy + offset));
          float blocker = step(sampleDepth, receiver - .00015);
          blockerSum += sampleDepth * blocker;
          blockers += blocker;
        }
        float averageBlocker = blockers > 0.0 ? blockerSum / blockers : receiver;
        // Convert the orthographic depth separation back to world units, then
        // apply a small angular source radius for a height-dependent penumbra.
        float blockerSeparationWorld = max(receiver - averageBlocker, 0.0) * 24.9;
        float filterRadius = clamp(.75 + blockerSeparationWorld * .06 / 10.0 * shadowMapSize.x, .75, 24.0);
        float lit = 0.0;
        for (int i = 0; i < FILTER_SAMPLES; i++) {
          float fi = float(i) + .5;
          float radius = filterRadius * sqrt(fi / float(FILTER_SAMPLES));
          vec2 offset = vec2(cos(fi * golden), sin(fi * golden)) * radius * texel;
          lit += texture2DCompare(shadowMap, shadowCoord.xy + offset, receiver);
        }
        return mix(1.0, lit / float(FILTER_SAMPLES), shadowIntensity);
      }
      float getShadow(sampler2D shadowMap, vec2 shadowMapSize, float shadowIntensity, float shadowBias, float shadowRadius, vec4 shadowCoord) {
        return cdPcssShadow(shadowMap, shadowMapSize, shadowIntensity, shadowBias, shadowRadius, shadowCoord);
      }
      #endif`;
    const hubShadow = `
      uniform vec3 cdDiscCenter;
      uniform vec3 cdDiscBasisX;
      uniform vec3 cdDiscBasisY;
      uniform vec3 cdDiscNormal;
      uniform float cdDiscRadius;
      uniform vec3 cdKeyDirection;
      float cdHubShadow() {
        float denominator = dot(cdDiscNormal, cdKeyDirection);
        if (abs(denominator) < .0001) return 0.0;
        float distanceToDisc = dot(cdDiscNormal, cdDiscCenter - cdShadowWorld) / denominator;
        if (distanceToDisc <= 0.0) return 0.0;
        vec3 hit = cdShadowWorld + cdKeyDirection * distanceToDisc;
        vec3 offset = hit - cdDiscCenter;
        float radial = length(vec2(dot(offset, cdDiscBasisX), dot(offset, cdDiscBasisY))) / max(cdDiscRadius, .0001);
        float angleSoftness = .06 * (1.0 - abs(denominator));
        float edge = max(fwidth(radial), .002 + angleSoftness * .08);
        float annulus = smoothstep(.225 - edge, .225 + edge, radial) * (1.0 - smoothstep(.58 - edge, .58 + edge, radial));
        float ring225 = 1.0 - smoothstep(.009 - edge, .009 + edge, abs(radial - .225));
        float ring510 = 1.0 - smoothstep(.009 - edge, .009 + edge, abs(radial - .51));
        return min(.08, annulus * (.03 + (ring225 + ring510) * .025));
      }
    `;
    shader.fragmentShader = `varying vec3 cdShadowWorld;\n${shader.fragmentShader}`;
    shader.fragmentShader = shader.fragmentShader.replace('#include <shadowmap_pars_fragment>', `${hubShadow}\n${pcss}`);
    const shadowOutput = 'gl_FragColor = vec4( color, opacity * ( 1.0 - getShadowMask() ) );';
    if (!shader.fragmentShader.includes(shadowOutput)) console.warn('CD shadow output changed; hub attenuation skipped');
    shader.fragmentShader = shader.fragmentShader.replace(shadowOutput, 'gl_FragColor = vec4( color, 1.0 - ( 1.0 - opacity * ( 1.0 - getShadowMask() ) ) * ( 1.0 - cdHubShadow() ) );');
  };
  const shadow = new T.Mesh(new T.PlaneGeometry(2000, 2000), shadowMaterial);
  shadow.position.z = -.02;
  shadow.receiveShadow = true;
  anchor.add(shadow);
  // A small receiver-plane approximation of reflected key light. It is only
  // shown when a lit disc face actually reflects down onto the desk.
  const bounceMaterial = new T.ShaderMaterial({
    transparent: true, depthWrite: false, depthTest: true, blending: T.NormalBlending,
    uniforms: { color: { value: new T.Color(0xb9d8df) }, strength: { value: 0 } },
    vertexShader: `varying vec2 bounceUv;
      void main() { bounceUv = uv - .5; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `uniform vec3 color; uniform float strength; varying vec2 bounceUv;
      void main() {
        float soft = 1.0 - smoothstep(.05, 1.0, length(bounceUv * 2.0));
        gl_FragColor = vec4(color, soft * strength);
      }`,
  });
  const bounceLight = new T.Mesh(new T.PlaneGeometry(1, 1), bounceMaterial);
  bounceLight.name = 'cd-bounce-light';
  bounceLight.position.z = -.019;
  bounceLight.visible = false;
  bounceAnchor.add(bounceLight);

  const { createCDPhysics } = await import('./cd-physics.mjs');
  const { world, body, RAPIER } = await createCDPhysics(radius, hole, thickness);
  let active = false, raf = 0, last = 0, accumulator = 0, fadeStarted = 0;
  const fadeDuration = 350;
  let retiring = null, pointer = null, focusDrop = false;
  let suppressClickUntil = 0;
  const step = 1 / 120;
  const previousPosition = new T.Vector3(), currentPosition = new T.Vector3();
  const previousRotation = new T.Quaternion(), currentRotation = new T.Quaternion();
  const targetPosition = new T.Vector3(), targetRotation = new T.Quaternion();
  const throwVelocity = new T.Vector3(), spinVelocity = new T.Vector3();
  const raycaster = new T.Raycaster(), mouse = new T.Vector2();
  const dragPlane = new T.Plane(), dragPoint = new T.Vector3();
  const rotation = new T.Quaternion();
  const axisX = new T.Vector3(1, 0, 0), axisY = new T.Vector3(0, 1, 0);
  const axisZ = new T.Vector3(0, 0, 1), discWorld = new T.Vector3(), lightVector = new T.Vector3();
  const faceNormal = new T.Vector3(), reflected = new T.Vector3(), hitPoint = new T.Vector3();
  const discWorldRotation = new T.Quaternion();
  let hoverX = 0, hoverY = 0, hoverPointerType = '';
  let hoverState = '';
  function clearHover(resetPointer = true) {
    if (resetPointer) hoverPointerType = '';
    if (hoverState) document.body.classList.remove('cd-hover');
    hoverState = '';
    document.body.style.removeProperty('--cd-cursor');
  }
  function setHover(state) {
    if (state === hoverState) return;
    hoverState = state;
    if (!state) { clearHover(); return; }
    document.body.classList.add('cd-hover');
    document.body.style.setProperty('--cd-cursor', state);
  }
  function isUiExempt(target) {
    return target?.closest?.('.cd-controls, dialog[open]');
  }
  function labelContact(contact) {
    const local = disc.worldToLocal(contact.point.clone());
    const labelX = (local.x / (radius * 2) + .5) * 2048;
    const labelY = (.5 - local.y / (radius * 2)) * 2048;
    return local.z > 0 && labelX >= labelArtwork.left && labelX <= labelArtwork.right && labelY >= labelArtwork.top && labelY <= labelArtwork.bottom;
  }
  function updateBounceLight() {
    disc.getWorldPosition(discWorld); disc.getWorldQuaternion(discWorldRotation);
    lightVector.copy(light.position).sub(discWorld);
    const lightDistance = lightVector.length();
    if (!Number.isFinite(lightDistance) || lightDistance < .001) { bounceLight.visible = false; return; }
    lightVector.multiplyScalar(1 / lightDistance);
    let best = null;
    for (const sign of [1, -1]) {
      faceNormal.copy(axisZ).applyQuaternion(discWorldRotation).multiplyScalar(sign);
      const facing = faceNormal.dot(lightVector);
      if (facing <= .04) continue;
      reflected.copy(faceNormal).multiplyScalar(2 * facing).sub(lightVector);
      if (reflected.z >= -.012) continue;
      const deskZ = anchor.position.z + anchor.scale.z * -.02;
      const distance = (deskZ - discWorld.z) / reflected.z;
      if (!Number.isFinite(distance) || distance <= 0 || distance > 18) continue;
      const score = facing * -reflected.z / (1 + distance * .22);
      if (!best || score > best.score) best = { distance, score, underside: sign < 0 };
    }
    if (!best) { bounceLight.visible = false; return; }
    hitPoint.copy(discWorld).addScaledVector(reflected, best.distance);
    const localHit = anchor.worldToLocal(hitPoint);
    const grazing = Math.min(1, -reflected.z);
    const strength = Math.min(.14, best.score * grazing * (best.underside ? .95 : .18));
    if (!Number.isFinite(strength) || strength < .002) { bounceLight.visible = false; return; }
    bounceLight.position.set(localHit.x, localHit.y, -.019);
    const size = Math.min(3.4, 1.15 + best.distance * .08);
    bounceLight.scale.set(size * (1.12 + (1 - grazing) * .7), size, 1);
    bounceMaterial.uniforms.color.value.set(best.underside ? 0x9ccfe0 : 0xe8e2cc);
    bounceMaterial.uniforms.strength.value = strength;
    bounceLight.visible = true;
  }
  function sync() {
    currentPosition.copy(body.translation()); currentRotation.copy(body.rotation());
    previousPosition.copy(currentPosition); previousRotation.copy(currentRotation);
    disc.position.copy(currentPosition); disc.quaternion.copy(currentRotation);
  }
  function position() {
    renderer.setSize(innerWidth, innerHeight);
    bounceRenderer.setSize(innerWidth, innerHeight);
    camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
    bounceCamera.aspect = camera.aspect; bounceCamera.updateProjectionMatrix();
    bounceCamera.position.copy(camera.position);
    bounceCamera.quaternion.copy(camera.quaternion);
    const rect = document.querySelector('#games').getBoundingClientRect();
    const worldHeight = 16 * Math.tan(T.MathUtils.degToRad(17.5));
    const diameter = Math.min(590, innerWidth * .84, innerHeight * .73);
    anchor.scale.setScalar(diameter / innerHeight * worldHeight / (radius * 2));
    anchor.position.set(((rect.left + rect.width / 2) / innerWidth - .5) * worldHeight * camera.aspect, (.5 - (rect.top + rect.height / 2) / innerHeight) * worldHeight, 0);
    anchor.updateMatrixWorld(true);
    bounceAnchor.position.copy(anchor.position);
    bounceAnchor.scale.copy(anchor.scale);
    bounceAnchor.quaternion.copy(anchor.quaternion);
    bounceAnchor.updateMatrixWorld(true);
  }
  function wake() {
    if (active && !raf) { last = performance.now(); raf = requestAnimationFrame(frame); }
  }
  function render() {
    anchor.updateMatrixWorld(true);
    disc.getWorldPosition(shadowDiscCenter);
    disc.getWorldQuaternion(discWorldRotation);
    shadowDiscBasisX.copy(axisX).applyQuaternion(discWorldRotation).normalize();
    shadowDiscBasisY.copy(axisY).applyQuaternion(discWorldRotation).normalize();
    shadowDiscNormal.copy(shadowDiscBasisX).cross(shadowDiscBasisY).normalize();
    shadowDiscUniforms.radius.value = anchor.scale.x;
    disc.getWorldPosition(light.target.position);
    light.position.copy(light.target.position).add(new T.Vector3(-3, 4, 8));
    light.target.updateMatrixWorld();
    updateBounceLight();
    if (hoverPointerType === 'mouse') updateHoverAt(hoverX, hoverY);
    bounceRenderer.clear();
    bounceRenderer.render(bounceScene, bounceCamera);
    renderer.render(scene, camera);
  }
  function frame(now) {
    raf = 0;
    if (!active) return;
    const dt = Math.min((now - last) / 1000, .1); last = now;
    const fading = fadeStarted > 0;
    if (fading) {
      const fadeProgress = Math.min((now - fadeStarted) / fadeDuration, 1);
      canvas.style.opacity = String(fadeProgress);
      bounceCanvas.style.opacity = String(fadeProgress);
      if (fadeProgress === 1) fadeStarted = 0;
    }
    if (retiring) {
      const t = Math.min((now - retiring.time) / 650, 1), rise = t * t;
      disc.position.copy(retiring.position);
      disc.position.z += rise * Math.max(0, 5.7 / anchor.scale.x - retiring.position.z);
      disc.position.y += rise * .45;
      disc.quaternion.copy(retiring.quaternion); disc.rotateZ(-rise * .18);
      canvas.style.filter = `blur(${rise * 32}px)`;
      canvas.style.opacity = String(1 - Math.max(0, (t - .5) * 2));
      bounceCanvas.style.filter = canvas.style.filter;
      bounceCanvas.style.opacity = canvas.style.opacity;
      render();
      if (t === 1) { hide(); dropButton.focus(); return; }
    } else {
      accumulator += dt;
      while (accumulator >= step) {
        previousPosition.copy(currentPosition); previousRotation.copy(currentRotation);
        if (pointer) {
          body.setNextKinematicTranslation(targetPosition);
          body.setNextKinematicRotation(targetRotation);
        }
        world.step();
        currentPosition.copy(body.translation()); currentRotation.copy(body.rotation());
        accumulator -= step;
      }
      const alpha = accumulator / step;
      disc.position.lerpVectors(previousPosition, currentPosition, alpha);
      disc.quaternion.slerpQuaternions(previousRotation, currentRotation, alpha);
      if (focusDrop) {
        const proximity = Math.max(0, Math.min(1, disc.position.z * anchor.scale.x / 5));
        canvas.style.filter = proximity > .03 ? `blur(${proximity ** 3 * 30}px)` : '';
        bounceCanvas.style.filter = canvas.style.filter;
        if (proximity <= .03) focusDrop = false;
      }
      render();
    }
    if (retiring || pointer || fading || fadeStarted || !body.isSleeping()) raf = requestAnimationFrame(frame);
  }
  function hit(event) {
    if (!active || document.querySelector('dialog[open]')) return null;
    mouse.set(event.clientX / innerWidth * 2 - 1, 1 - event.clientY / innerHeight * 2);
    raycaster.setFromCamera(mouse, camera);
    return raycaster.intersectObject(disc, true)[0];
  }
  function updateHoverAt(x, y) {
    if (!active || !hoverPointerType || document.querySelector('dialog[open]')) { clearHover(false); return; }
    if (pointer) { setHover('grabbing'); return; }
    mouse.set(x / innerWidth * 2 - 1, 1 - y / innerHeight * 2);
    raycaster.setFromCamera(mouse, camera);
    const contact = raycaster.intersectObject(disc, true)[0];
    if (!contact) { clearHover(false); return; }
    setHover(retiring || focusDrop ? 'wait' : labelContact(contact) ? 'pointer' : 'grab');
  }
  function updateHover(event) {
    if (event.pointerType === 'touch' || isUiExempt(event.target)) { clearHover(); return; }
    hoverPointerType = event.pointerType || 'mouse'; hoverX = event.clientX; hoverY = event.clientY;
    updateHoverAt(hoverX, hoverY);
  }
  function grabHeight(q) {
    const normal = new T.Vector3(0, 0, 1).applyQuaternion(q);
    // Only the user's hold target needs geometric clearance; Rapier resolves release.
    return radius * Math.sqrt(Math.max(0, 1 - normal.z ** 2)) + thickness / 2 + .08;
  }
  document.addEventListener('pointerdown', event => {
    if (event.button !== 0 || event.target.closest('.cd-controls, dialog[open]')) return;
    const contact = hit(event); if (!contact) return;
    event.preventDefault(); event.stopImmediatePropagation();
    if (retiring || focusDrop) return;
    const local = disc.worldToLocal(contact.point.clone());
    const move = Math.hypot(local.x, local.y) < .59;
    pointer = { id: event.pointerId, x: event.clientX, y: event.clientY, startX: event.clientX, startY: event.clientY, time: performance.now(), pressed: performance.now(), moved: false, move,
      onLabel: labelContact(contact) };
    targetPosition.copy(body.translation()); targetRotation.copy(body.rotation());
    throwVelocity.set(0, 0, 0); spinVelocity.set(0, 0, 0);
    body.setBodyType(RAPIER.RigidBodyType.KinematicPositionBased, true);
    if (move) targetPosition.z = Math.max(targetPosition.z, grabHeight(targetRotation) + .4);
    const worldPoint = anchor.localToWorld(targetPosition.clone());
    dragPlane.set(new T.Vector3(0, 0, 1), -worldPoint.z);
    raycaster.ray.intersectPlane(dragPlane, dragPoint);
    pointer.offset = targetPosition.clone().sub(anchor.worldToLocal(dragPoint.clone()));
    document.body.classList.add('cd-dragging'); wake();
  }, true);
  document.addEventListener('pointermove', event => {
    updateHover(event);
    if (!pointer || pointer.id !== event.pointerId) return;
    event.preventDefault();
    const now = performance.now(), elapsed = Math.max((now - pointer.time) / 1000, .008);
    if (Math.hypot(event.clientX - pointer.startX, event.clientY - pointer.startY) > 7) pointer.moved = true;
    if (pointer.onLabel && !pointer.moved) return;
    if (pointer.move) {
      mouse.set(event.clientX / innerWidth * 2 - 1, 1 - event.clientY / innerHeight * 2);
      raycaster.setFromCamera(mouse, camera);
      if (raycaster.ray.intersectPlane(dragPlane, dragPoint)) {
        const next = anchor.worldToLocal(dragPoint.clone()).add(pointer.offset);
        throwVelocity.lerp(next.clone().sub(targetPosition).divideScalar(elapsed).clampLength(0, 12), .55);
        targetPosition.copy(next);
      }
    } else {
      const dx = (event.clientX - pointer.x) * .008, dy = (event.clientY - pointer.y) * .008;
      rotation.setFromAxisAngle(axisY, dx); targetRotation.premultiply(rotation);
      rotation.setFromAxisAngle(axisX, dy); targetRotation.premultiply(rotation);
      targetPosition.z = Math.max(targetPosition.z, grabHeight(targetRotation));
      spinVelocity.set(T.MathUtils.clamp(dy / elapsed, -12, 12), T.MathUtils.clamp(dx / elapsed, -12, 12), 0);
    }
    pointer.x = event.clientX; pointer.y = event.clientY; pointer.time = now; wake();
  }, { passive: false });
  function release(event) {
    if (!pointer || (event?.pointerId !== undefined && event.pointerId !== pointer.id)) return;
    const tracks = event?.type === 'pointerup' && pointer.onLabel && !pointer.moved && performance.now() - pointer.pressed < 450;
    const stale = performance.now() - pointer.time > 100 || reduced.matches || event?.type === 'pointercancel';
    // Commit the last held pose even if release precedes the next physics tick.
    body.setTranslation(targetPosition, true); body.setRotation(targetRotation, true);
    body.setBodyType(RAPIER.RigidBodyType.Dynamic, true);
    body.setLinvel(stale ? { x: 0, y: 0, z: 0 } : throwVelocity, true);
    body.setAngvel(stale || tracks ? { x: 0, y: 0, z: 0 } : spinVelocity, true);
    pointer = null; suppressClickUntil = performance.now() + 400;
    document.body.classList.remove('cd-dragging'); sync(); wake();
    if (tracks) document.dispatchEvent(new Event('cd-open-games'));
  }
  document.addEventListener('pointerup', release);
  document.addEventListener('pointercancel', release);
  addEventListener('blur', () => { release({ type: 'pointercancel' }); clearHover(); });
  document.addEventListener('pointerleave', clearHover);
  document.addEventListener('click', event => {
    if (event.detail === 0 || event.target.closest('.cd-controls, dialog[open]')) return;
    if (performance.now() < suppressClickUntil || hit(event)) { event.preventDefault(); event.stopImmediatePropagation(); }
  }, true);
  function suppressCDContext(event) {
    if (event.target.closest('.cd-controls, dialog[open]') || !hit(event)) return;
    event.preventDefault(); event.stopImmediatePropagation();
  }
  document.addEventListener('auxclick', suppressCDContext, true);
  document.addEventListener('contextmenu', suppressCDContext, true);
  function hide() {
    release(); active = false; retiring = null; fadeStarted = 0; body.sleep();
    clearHover();
    canvas.hidden = controls.hidden = true; canvas.style.display = controls.style.display = 'none';
    bounceCanvas.hidden = true; bounceCanvas.style.display = 'none';
    renderer.clear(); bounceRenderer.clear(); cancelAnimationFrame(raf); raf = 0; accumulator = 0;
  }
  function button(label, action) {
    const b = document.createElement('button'); b.type = 'button'; b.textContent = label;
    b.addEventListener('click', event => { event.stopPropagation(); action(); }); controls.append(b);
  }
  button('Flip', () => {
    release(); focusDrop = false; canvas.style.filter = ''; bounceCanvas.style.filter = '';
    if (reduced.matches) {
      const q = new T.Quaternion().setFromAxisAngle(axisY, Math.PI).multiply(new T.Quaternion().copy(body.rotation()));
      body.setRotation(q, true); body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    } else {
      // Give the disc enough airtime for its wide rim to clear the desk, then
      // use the matching half-turn spin; both impulses remain Rapier-driven.
      body.setLinvel({ x: 0, y: 0, z: 14 }, true);
      body.setAngvel({ x: .12, y: 4, z: .15 }, true);
    }
    sync(); wake();
  });
  button('Tracks', () => document.dispatchEvent(new Event('cd-open-games')));
  button('Drop again', drop);
  button('Put away', () => {
    if (reduced.matches) { hide(); dropButton.focus(); return; }
    release(); fadeStarted = 0; retiring = { time: performance.now(), position: disc.position.clone(), quaternion: disc.quaternion.clone() };
    body.sleep(); controls.hidden = true; controls.style.display = 'none'; wake();
  });
  controls.addEventListener('click', event => event.stopPropagation());
  addEventListener('resize', () => { if (active) { position(); wake(); } });
  addEventListener('scroll', () => { if (active) { position(); wake(); } }, { passive: true });
  document.addEventListener('simpleviewchange', () => { if (document.documentElement.classList.contains('simple-view')) hide(); });
  function drop() {
    release(); active = true; retiring = null; fadeStarted = reduced.matches ? 0 : performance.now(); accumulator = 0;
    canvas.hidden = controls.hidden = false; canvas.style.display = 'block'; controls.style.display = 'flex';
    bounceCanvas.hidden = false; bounceCanvas.style.display = 'block';
    canvas.style.opacity = reduced.matches ? '1' : '0'; canvas.style.filter = '';
    bounceCanvas.style.opacity = canvas.style.opacity; bounceCanvas.style.filter = '';
    position();
    const q = new T.Quaternion().setFromEuler(new T.Euler(reduced.matches ? 0 : .35, reduced.matches ? 0 : -.2, -.16));
    body.setBodyType(RAPIER.RigidBodyType.Dynamic, true);
    body.setTranslation({ x: 0, y: 0, z: reduced.matches ? .002 : 5 / anchor.scale.x }, true);
    body.setRotation(q, true); body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    focusDrop = !reduced.matches; sync(); wake();
  }
  return { drop };
}
