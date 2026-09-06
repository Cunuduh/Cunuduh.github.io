(() => {
  const canvas = document.getElementById("watercolor-background");
  if (!canvas) return;

  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const isSafari = isIOS || (
    /Safari/.test(navigator.userAgent) &&
    !/Chrome|Chromium|CriOS|Edg|OPR|Android/.test(navigator.userAgent)
  );
  if (isSafari) document.documentElement.classList.add("safari");

  const smallDevice = window.matchMedia("(max-width: 767px), (pointer: coarse)");
  const simulationDisabled = () => smallDevice.matches ||
    document.documentElement.classList.contains("simple-view");
  if (smallDevice.matches) {
    canvas.hidden = true;
    document.querySelector(".interaction-hint")?.setAttribute("hidden", "");
    return;
  }

  const fail = (message, error) => {
    console.error(`[watercolour] ${message}`, error || "");
  };

  const unavailable = (message, error) => {
    fail(message, error);
    const hint = document.querySelector(".interaction-hint");
    // WebGPU diagnostics belong in the console; never expose browser-specific
    // compiler errors in the receipt artwork.
    hint?.setAttribute("hidden", "");
  };

  async function start() {
    if (!navigator.gpu) {
      unavailable("WebGPU is required for the watercolour background.");
      return;
    }

    const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" }) ||
      await navigator.gpu.requestAdapter();
    if (!adapter) {
      unavailable("No WebGPU adapter is available.");
      return;
    }
    const device = await adapter.requestDevice();
    device.lost.then(info => unavailable(`WebGPU device lost: ${info.message || info.reason}`));
    device.addEventListener("uncapturederror", event => {
      unavailable("WebGPU validation error.", event.error);
    });

    const context = canvas.getContext("webgpu");
    if (!context) throw new Error("Could not create the WebGPU canvas context.");

    const format = navigator.gpu.getPreferredCanvasFormat();
    context.configure({ device, format, alphaMode: "premultiplied" });

    const stateAspect = 1.6;
    const ringCapacity = 288;
    const particlesPerRing = 384;
    const particleCount = ringCapacity * particlesPerRing;
    const particleStride = 40;
    const ringStride = 32;
    const gridWidth = 128;
    const gridHeight = 80;
    const gridSlots = 12;
    const gridEntryCount = gridWidth * gridHeight * gridSlots;
    const collisionIterations = 3;
    const propagationDuration = 8.2;
    const sourceLifetime = propagationDuration;
    const automaticSplashInterval = 1875;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const receipt = document.querySelector(".receipt-shell");
    let paused = document.hidden || simulationDisabled();
    let frameInFlight = false;
    let frameTimer = null;
    let lastFrame = performance.now();
    let nextAutomaticSplash = lastFrame + 1500;
    let lastSubmitTime = 0;
    const ringSlots = new Array(ringCapacity).fill(null);
    const ringBacking = new ArrayBuffer(ringCapacity * ringStride);
    const ringFloats = new Float32Array(ringBacking);
    const ringUints = new Uint32Array(ringBacking);
    const frameBacking = new ArrayBuffer(32);
    const frameFloats = new Float32Array(frameBacking);
    const frameUints = new Uint32Array(frameBacking);
    let randomSeed = 1439281;
    let nextGroup = 1;
    let automaticRegionIndex = 0;

    const frameBuffer = device.createBuffer({
      label: "watercolour frame uniforms",
      size: 32,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });
    const particleBuffer = device.createBuffer({
      label: "watercolour wavefront particles",
      size: particleCount * particleStride,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
    });
    const ringBuffer = device.createBuffer({
      label: "watercolour ring data",
      size: ringCapacity * ringStride,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
    });
    const occupancyBuffer = device.createBuffer({
      label: "watercolour collision occupancy",
      size: gridEntryCount * Uint32Array.BYTES_PER_ELEMENT,
      usage: GPUBufferUsage.STORAGE
    });
    const collisionBuffer = device.createBuffer({
      label: "watercolour collision forces",
      size: particleCount * 4 * Float32Array.BYTES_PER_ELEMENT,
      usage: GPUBufferUsage.STORAGE
    });
    const frontBuffer = device.createBuffer({
      label: "watercolour reconstructed fronts",
      size: particleCount * 2 * Float32Array.BYTES_PER_ELEMENT,
      usage: GPUBufferUsage.STORAGE
    });
    function random() {
      randomSeed ^= randomSeed << 13;
      randomSeed ^= randomSeed >>> 17;
      randomSeed ^= randomSeed << 5;
      return (randomSeed >>> 0) / 4294967295;
    }

    async function makePaperTexture() {
      try {
        const response = await fetch("img/watercolour-paper-tile.webp");
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const bitmap = await createImageBitmap(await response.blob());
        const texture = device.createTexture({
          label: "watercolour paper",
          size: [bitmap.width, bitmap.height],
          format: "rgba8unorm",
          usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST |
            GPUTextureUsage.RENDER_ATTACHMENT
        });
        device.queue.copyExternalImageToTexture(
          { source: bitmap, flipY: true },
          { texture },
          [bitmap.width, bitmap.height]
        );
        bitmap.close?.();
        return texture;
      } catch (error) {
        console.warn("[watercolour] Paper texture unavailable; using procedural steering.", error);
        const texture = device.createTexture({
          label: "watercolour paper fallback",
          size: [1, 1],
          format: "rgba8unorm",
          usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST
        });
        device.queue.writeTexture(
          { texture },
          new Uint8Array([184, 184, 184, 255]),
          { bytesPerRow: 4 },
          [1, 1]
        );
        return texture;
      }
    }

    const paperTexture = await makePaperTexture();
    const paperSampler = device.createSampler({
      addressModeU: "repeat",
      addressModeV: "repeat",
      magFilter: "linear",
      minFilter: "linear"
    });

    const computeCode = `
      const PI: f32 = 3.14159265359;
      const TAU: f32 = 6.28318530718;
      const PARTICLE_COUNT: u32 = ${particleCount}u;
      const PARTICLES_PER_RING: u32 = ${particlesPerRing}u;
      const GRID_SLOTS: u32 = ${gridSlots}u;
      const GRID_ENTRY_COUNT: u32 = ${gridEntryCount}u;

      struct Frame {
        now: f32,
        delta: f32,
        aspect: f32,
        particleCount: u32,
        canvasSize: vec2f,
        gridSize: vec2u,
      };

      struct Particle {
        position: vec2f,
        radial: f32,
        angle: f32,
        drift: f32,
        seed: f32,
        motionState: u32,
        radialVelocity: f32,
        alive: u32,
        ringIndex: u32,
      };

      struct Ring {
        center: vec2f,
        birth: f32,
        maxRadius: f32,
        strength: f32,
        seed: f32,
        group: u32,
        enabled: u32,
      };

      @group(0) @binding(0) var<uniform> frame: Frame;
      @group(0) @binding(1) var<storage, read_write> particles: array<Particle>;
      @group(0) @binding(2) var<storage, read> rings: array<Ring>;
      @group(0) @binding(3) var<storage, read_write> occupancy: array<atomic<u32>>;
      @group(0) @binding(4) var<storage, read_write> collisionForces: array<vec4f>;
      @group(0) @binding(5) var<storage, read_write> frontPositions: array<vec2f>;
      @group(0) @binding(6) var paper: texture_2d<f32>;
      @group(0) @binding(7) var paperSampler: sampler;

      fn hash(value: f32) -> f32 {
        return fract(sin(value * 127.1) * 43758.5453);
      }

      fn periodicNoise(turn: f32, frequency: u32, seed: f32) -> f32 {
        let scaled = fract(turn) * f32(frequency);
        let node = u32(floor(scaled));
        let next = (node + 1u) % frequency;
        var blend = fract(scaled);
        blend = blend * blend * (3.0 - 2.0 * blend);
        return mix(hash(f32(node) + seed), hash(f32(next) + seed), blend);
      }

      fn insideDomain(position: vec2f) -> bool {
        return position.x >= 0.0 && position.x < frame.aspect &&
          position.y >= 0.0 && position.y < 1.0;
      }

      fn gridCell(position: vec2f) -> vec2u {
        let normalized = clamp(position / vec2f(frame.aspect, 1.0), vec2f(0.0), vec2f(0.999999));
        return vec2u(normalized * vec2f(frame.gridSize));
      }

      fn visibility(age: f32) -> f32 {
        return 1.0 - smoothstep(7.4, ${sourceLifetime.toFixed(1)}, age);
      }

      @compute @workgroup_size(256)
      fn clearSpatialData(@builtin(global_invocation_id) invocation: vec3u) {
        let index = invocation.x;
        if (index < GRID_ENTRY_COUNT) {
          atomicStore(&occupancy[index], 0u);
        }
        if (index < PARTICLE_COUNT) {
          collisionForces[index] = vec4f(0.0);
        }
      }

      @compute @workgroup_size(128)
      fn advance(@builtin(global_invocation_id) invocation: vec3u) {
        let index = invocation.x;
        if (index >= frame.particleCount || index >= PARTICLE_COUNT) { return; }

        var particle = particles[index];
        if (particle.alive == 0u) { return; }

        let ring = rings[particle.ringIndex];
        let age = frame.now - ring.birth;
        if (ring.enabled == 0u || age > ${sourceLifetime.toFixed(1)}) {
          particle.alive = 0u;
          particles[index] = particle;
          return;
        }
        if (age < 0.0) { return; }

        let turn = particle.angle / TAU;
        let coarse = periodicNoise(turn, 7u, ring.seed) - 0.5;
        let detail = periodicNoise(turn, 23u, ring.seed + 19.7) - 0.5;
        let direction = vec2f(cos(particle.angle + particle.drift), sin(particle.angle + particle.drift));
        let samplePosition = ring.center + direction * max(particle.radial, 0.001);
        // All splashes share the same fixed paper terrain beneath the wash.
        let paperUv = samplePosition / vec2f(frame.aspect, 1.0) * 2.3;
        let paperValue = textureSampleLevel(paper, paperSampler, paperUv, 0.0).r - 0.72;
        let localMaximum = ring.maxRadius * (1.0 + coarse * 0.15 + detail * 0.105 + paperValue * 0.075);
        let progress = clamp(age / ${propagationDuration.toFixed(1)}, 0.0, 1.0);
        let speed = localMaximum * (PI * 0.5 / ${propagationDuration.toFixed(1)}) *
          max(cos(progress * PI * 0.5), 0.0);
        let particleVariation = hash(particle.seed) - 0.5;
        let resistance = clamp(
          1.0 + paperValue * 0.24 + detail * 0.08 + particleVariation * 0.025,
          0.82,
          1.18
        );
        let naturalVelocity = speed * resistance;
        if (particle.motionState == 0u) {
          let accelerationResponse = 1.0 - exp(-2.4 * frame.delta);
          particle.radialVelocity = mix(
            particle.radialVelocity,
            naturalVelocity,
            accelerationResponse
          );
          particle.radial = min(
            localMaximum,
            particle.radial + particle.radialVelocity * frame.delta
          );
        } else {
          particle.radialVelocity *= exp(-0.7 * frame.delta);
          if (abs(particle.radialVelocity) < 0.0003) {
            particle.radialVelocity = 0.0;
          }
          particle.radial = clamp(
            particle.radial + particle.radialVelocity * frame.delta,
            0.0002,
            localMaximum
          );
        }
        let sideways = periodicNoise(turn, 13u, ring.seed + 41.3) - 0.5;
        particle.drift += (sideways * 0.005 + paperValue * 0.002) * frame.delta;
        particle.drift = clamp(particle.drift, -0.014, 0.014);
        let movedDirection = vec2f(cos(particle.angle + particle.drift), sin(particle.angle + particle.drift));
        particle.position = ring.center + movedDirection * particle.radial;
        particles[index] = particle;
      }

      @compute @workgroup_size(128)
      fn reconstructFront(@builtin(global_invocation_id) invocation: vec3u) {
        let index = invocation.x;
        if (index >= frame.particleCount || index >= PARTICLE_COUNT) { return; }
        let particle = particles[index];
        let ring = rings[particle.ringIndex];
        let age = frame.now - ring.birth;
        if (particle.alive == 0u || ring.enabled == 0u || age < 0.0) {
          frontPositions[index] = particle.position;
          return;
        }

        let localIndex = index % PARTICLES_PER_RING;
        let ringStart = index - localIndex;
        var radial = 0.0;
        var drift = 0.0;
        var totalWeight = 0.0;
        for (var offset = -8; offset <= 8; offset++) {
          let wrapped = (i32(localIndex) + offset + i32(PARTICLES_PER_RING)) %
            i32(PARTICLES_PER_RING);
          let distance = f32(abs(offset));
          let weight = exp(-0.5 * distance * distance / 12.25);
          let sampleParticle = particles[ringStart + u32(wrapped)];
          radial += sampleParticle.radial * weight;
          drift += sampleParticle.drift * weight;
          totalWeight += weight;
        }
        let direction = vec2f(
          cos(particle.angle + drift / totalWeight),
          sin(particle.angle + drift / totalWeight)
        );
        frontPositions[index] = ring.center + direction * (radial / totalWeight);
      }

      @compute @workgroup_size(128)
      fn fillGrid(@builtin(global_invocation_id) invocation: vec3u) {
        let index = invocation.x;
        if (index >= frame.particleCount || index >= PARTICLE_COUNT || particles[index].alive == 0u) { return; }
        let particle = particles[index];
        let ring = rings[particle.ringIndex];
        let age = frame.now - ring.birth;
        if (ring.enabled == 0u || age < 0.0 || visibility(age) < 0.12) { return; }

        let localIndex = index % PARTICLES_PER_RING;
        let ringStart = index - localIndex;
        let nextIndex = ringStart + (localIndex + 1u) % PARTICLES_PER_RING;
        let midpoint = (frontPositions[index] + frontPositions[nextIndex]) * 0.5;
        if (!insideDomain(midpoint)) { return; }
        let cell = gridCell(midpoint);
        let base = (cell.y * frame.gridSize.x + cell.x) * GRID_SLOTS;
        for (var slot = 0u; slot < GRID_SLOTS; slot++) {
          let entry = base + slot;
          if (atomicLoad(&occupancy[entry]) == 0u) {
            let exchange = atomicCompareExchangeWeak(&occupancy[entry], 0u, index + 1u);
            if (exchange.exchanged) { return; }
          }
        }
      }

      @compute @workgroup_size(128)
      fn detectCollisions(@builtin(global_invocation_id) invocation: vec3u) {
        let index = invocation.x;
        if (index >= frame.particleCount || index >= PARTICLE_COUNT || particles[index].alive == 0u) { return; }
        let particle = particles[index];
        let ring = rings[particle.ringIndex];
        let age = frame.now - ring.birth;
        let point = frontPositions[index];
        if (ring.enabled == 0u || age < 0.0 || visibility(age) < 0.12 || !insideDomain(point)) { return; }

        let cell = gridCell(point);
        let particleDirection = normalize(point - ring.center);
        let particleWorldVelocity = particleDirection * particle.radialVelocity;
        let particleMass = 1.0 + min(abs(particle.radialVelocity) / 0.045, 1.0);
        var velocityTarget = 0.0;
        var radialCorrection = 0.0;
        var contactWeight = 0.0;
        for (var offsetY = -1; offsetY <= 1; offsetY++) {
          for (var offsetX = -1; offsetX <= 1; offsetX++) {
            let x = clamp(i32(cell.x) + offsetX, 0, i32(frame.gridSize.x) - 1);
            let y = clamp(i32(cell.y) + offsetY, 0, i32(frame.gridSize.y) - 1);
            let base = (u32(y) * frame.gridSize.x + u32(x)) * GRID_SLOTS;
            for (var slot = 0u; slot < GRID_SLOTS; slot++) {
              let occupant = atomicLoad(&occupancy[base + slot]);
              if (occupant == 0u) { continue; }
              let segmentIndex = occupant - 1u;
              let other = particles[segmentIndex];
              if (other.ringIndex == particle.ringIndex) { continue; }
              let otherRing = rings[other.ringIndex];
              let otherAge = frame.now - otherRing.birth;
              if (otherRing.enabled == 0u || visibility(otherAge) < 0.12) { continue; }

              let otherLocalIndex = segmentIndex % PARTICLES_PER_RING;
              let otherRingStart = segmentIndex - otherLocalIndex;
              let otherNextIndex = otherRingStart +
                (otherLocalIndex + 1u) % PARTICLES_PER_RING;
              let segmentStart = frontPositions[segmentIndex];
              let segmentEnd = frontPositions[otherNextIndex];
              let segment = segmentEnd - segmentStart;
              let segmentLengthSquared = max(dot(segment, segment), 0.0000001);
              let along = clamp(dot(point - segmentStart, segment) / segmentLengthSquared, 0.0, 1.0);
              let closest = segmentStart + segment * along;
              let separationVector = point - closest;
              let separation = length(separationVector);
              if (separation >= 0.014) { continue; }

              var away = separationVector / max(separation, 0.0001);
              if (separation < 0.0001) {
                away = normalize(ring.center - otherRing.center + vec2f(0.0001, 0.0));
              }
              let otherNext = particles[otherNextIndex];
              let otherStartDirection = normalize(segmentStart - otherRing.center);
              let otherEndDirection = normalize(segmentEnd - otherRing.center);
              let otherWorldVelocity = mix(
                otherStartDirection * other.radialVelocity,
                otherEndDirection * otherNext.radialVelocity,
                along
              );
              let otherSpeed = mix(
                abs(other.radialVelocity),
                abs(otherNext.radialVelocity),
                along
              );
              let otherMass = 1.0 + min(otherSpeed / 0.045, 1.0);
              let ownNormalVelocity = dot(particleWorldVelocity, away);
              let otherNormalVelocity = dot(otherWorldVelocity, away);
              let approachSpeed = otherNormalVelocity - ownNormalVelocity;
              let combinedMass = particleMass + otherMass;
              let sharedNormalVelocity =
                (ownNormalVelocity * particleMass + otherNormalVelocity * otherMass) /
                combinedMass;
              var resolvedVelocity = particle.radialVelocity;
              if (approachSpeed > 0.0) {
                resolvedVelocity += (sharedNormalVelocity - ownNormalVelocity) *
                  dot(away, particleDirection);
              }
              let contact = 1.0 - smoothstep(0.004, 0.014, separation);
              let penetration = max(0.0, 0.01 - separation);
              let correction = dot(
                away * penetration * (otherMass / combinedMass),
                particleDirection
              );
              velocityTarget += resolvedVelocity * contact;
              radialCorrection += correction * contact;
              contactWeight += contact;
            }
          }
        }

        if (contactWeight > 0.0) {
          collisionForces[index] = vec4f(
            velocityTarget / contactWeight,
            radialCorrection / contactWeight,
            min(contactWeight, 1.0),
            0.0
          );
        }
      }

      @compute @workgroup_size(128)
      fn applyCollisions(@builtin(global_invocation_id) invocation: vec3u) {
        let index = invocation.x;
        if (index >= frame.particleCount || index >= PARTICLE_COUNT || particles[index].alive == 0u) { return; }
        var particle = particles[index];
        let ring = rings[particle.ringIndex];
        let age = frame.now - ring.birth;
        if (ring.enabled == 0u || age < 0.0 || visibility(age) < 0.12) { return; }

        let localIndex = index % PARTICLES_PER_RING;
        let ringStart = index - localIndex;
        var velocityTarget = 0.0;
        var radialCorrection = 0.0;
        var contactWeight = 0.0;
        for (var offset = -7; offset <= 7; offset++) {
          let wrapped = (i32(localIndex) + offset + i32(PARTICLES_PER_RING)) %
            i32(PARTICLES_PER_RING);
          let distance = f32(abs(offset));
          let kernel = exp(-0.5 * distance * distance / 9.0);
          let collision = collisionForces[ringStart + u32(wrapped)];
          velocityTarget += collision.x * collision.z * kernel;
          radialCorrection += collision.y * collision.z * kernel;
          contactWeight += collision.z * kernel;
        }
        if (contactWeight > 0.0001) {
          let resolvedVelocity = velocityTarget / contactWeight;
          let correction = radialCorrection / contactWeight;
          particle.radialVelocity = mix(particle.radialVelocity, resolvedVelocity, 0.62);
          // Dissipate compression so crowded fronts do not launch long inward folds.
          if (particle.radialVelocity < 0.0) {
            particle.radialVelocity *= exp(-3.0 * frame.delta);
          }
          particle.radial = max(
            0.0002,
            particle.radial + clamp(correction, -0.004, 0.004) * 0.72
          );
          particle.motionState = 1u;
          let direction = vec2f(
            cos(particle.angle + particle.drift),
            sin(particle.angle + particle.drift)
          );
          particle.position = ring.center + direction * particle.radial;
          particles[index] = particle;
        }
      }

      @compute @workgroup_size(128)
      fn calculateConstraints(@builtin(global_invocation_id) invocation: vec3u) {
        let index = invocation.x;
        if (index >= frame.particleCount || index >= PARTICLE_COUNT || particles[index].alive == 0u) { return; }
        let particle = particles[index];
        let ring = rings[particle.ringIndex];
        let age = frame.now - ring.birth;
        if (ring.enabled == 0u || age < 0.0) { return; }

        let localIndex = index % PARTICLES_PER_RING;
        let ringStart = index - localIndex;
        let previousIndex = ringStart + (localIndex + PARTICLES_PER_RING - 1u) % PARTICLES_PER_RING;
        let nextIndex = ringStart + (localIndex + 1u) % PARTICLES_PER_RING;
        let previousRadius = particles[previousIndex].radial;
        let nextRadius = particles[nextIndex].radial;
        let steepness = max(
          abs(previousRadius - particle.radial),
          abs(nextRadius - particle.radial)
        );
        let smoothing = smoothstep(0.0035, 0.012, steepness);
        let neighbourRadius = (previousRadius + nextRadius) * 0.5;
        let correction = clamp((neighbourRadius - particle.radial) * smoothing * 0.34, -0.002, 0.002);
        collisionForces[index] = vec4f(correction, 0.0, 0.0, 0.0);
      }

      @compute @workgroup_size(128)
      fn applyConstraints(@builtin(global_invocation_id) invocation: vec3u) {
        let index = invocation.x;
        if (index >= frame.particleCount || index >= PARTICLE_COUNT || particles[index].alive == 0u) { return; }
        var particle = particles[index];
        let ring = rings[particle.ringIndex];
        let age = frame.now - ring.birth;
        if (ring.enabled == 0u || age < 0.0) { return; }

        particle.radial = max(0.0002, particle.radial + collisionForces[index].x);
        let direction = vec2f(cos(particle.angle + particle.drift), sin(particle.angle + particle.drift));
        particle.position = ring.center + direction * particle.radial;
        particles[index] = particle;
      }
    `;

    const drawCode = `
      const TAU: f32 = 6.28318530718;
      const PARTICLES_PER_RING: u32 = ${particlesPerRing}u;

      struct Frame {
        now: f32,
        delta: f32,
        aspect: f32,
        particleCount: u32,
        canvasSize: vec2f,
        gridSize: vec2u,
      };

      struct Particle {
        position: vec2f,
        radial: f32,
        angle: f32,
        drift: f32,
        seed: f32,
        motionState: u32,
        radialVelocity: f32,
        alive: u32,
        ringIndex: u32,
      };

      struct Ring {
        center: vec2f,
        birth: f32,
        maxRadius: f32,
        strength: f32,
        seed: f32,
        group: u32,
        enabled: u32,
      };

      struct VertexOutput {
        @builtin(position) position: vec4f,
        @location(0) local: vec2f,
        @location(1) strength: f32,
        @location(2) drying: f32,
        @location(3) retreatVariation: f32,
        @location(4) pigmentConcentration: f32,
        @location(5) pigmentCoordinates: vec2f,
        @location(6) paperUv: vec2f,
      };

      @group(0) @binding(0) var<uniform> frame: Frame;
      @group(0) @binding(1) var<storage, read> particles: array<Particle>;
      @group(0) @binding(2) var<storage, read> rings: array<Ring>;
      @group(0) @binding(3) var<storage, read> frontPositions: array<vec2f>;
      @group(0) @binding(4) var paper: texture_2d<f32>;
      @group(0) @binding(5) var paperSampler: sampler;

      fn hash(value: f32) -> f32 {
        return fract(sin(value * 127.1) * 43758.5453);
      }

      fn periodicNoise(turn: f32, frequency: u32, seed: f32) -> f32 {
        let scaled = fract(turn) * f32(frequency);
        let node = u32(floor(scaled));
        let next = (node + 1u) % frequency;
        var blend = fract(scaled);
        blend = blend * blend * (3.0 - 2.0 * blend);
        return mix(hash(f32(node) + seed), hash(f32(next) + seed), blend);
      }

      fn retreatVariation(turn: f32, seed: f32) -> f32 {
        let angularWarp = (periodicNoise(turn, 7u, seed + 43.6) - 0.5) * 0.05;
        let warpedTurn = turn + angularWarp;
        let broad = periodicNoise(warpedTurn, 9u, seed + 73.1) - 0.5;
        let medium = periodicNoise(warpedTurn + broad * 0.035, 21u, seed + 101.3) - 0.5;
        let fingerSource = periodicNoise(warpedTurn + medium * 0.018, 37u, seed + 131.7);
        let fingers = pow(fingerSource, 3.4) - 0.23;
        let feather = periodicNoise(warpedTurn, 53u, seed + 197.9) - 0.5;
        return broad * 0.13 + medium * 0.09 + fingers * 0.17 + feather * 0.035;
      }

      fn pigmentConcentration(turn: f32, seed: f32) -> f32 {
        let angularWarp = (periodicNoise(turn, 7u, seed + 43.6) - 0.5) * 0.035;
        let warpedTurn = turn + angularWarp;
        let primary = pow(periodicNoise(warpedTurn, 17u, seed + 229.4), 1.55);
        let fine = pow(periodicNoise(warpedTurn, 37u, seed + 311.8), 2.6);
        return clamp(max(primary, fine * 0.68), 0.0, 1.0);
      }

      fn frontNormal(
        particleIndex: u32,
        ringStart: u32,
        center: vec2f,
        position: vec2f
      ) -> vec2f {
        let localIndex = particleIndex - ringStart;
        let previousIndex = ringStart +
          (localIndex + PARTICLES_PER_RING - 8u) % PARTICLES_PER_RING;
        let nextIndex = ringStart + (localIndex + 8u) % PARTICLES_PER_RING;
        let tangent =
          frontPositions[nextIndex] -
          frontPositions[previousIndex];
        let radial = normalize(position - center);
        if (length(tangent) < 0.0001) { return radial; }
        var normal = normalize(vec2f(-tangent.y, tangent.x));
        if (dot(normal, radial) < 0.0) { normal = -normal; }
        return normalize(mix(radial, normal, 0.68));
      }

      @vertex
      fn vertexMain(
        @builtin(vertex_index) vertexIndex: u32,
        @builtin(instance_index) instanceIndex: u32
      ) -> VertexOutput {
        let corners = array<vec2f, 6>(
          vec2f(-1.0, 0.0), vec2f(0.18, 0.0), vec2f(-1.0, 1.0),
          vec2f(-1.0, 1.0), vec2f(0.18, 0.0), vec2f(0.18, 1.0)
        );
        var output: VertexOutput;
        if (instanceIndex >= frame.particleCount || instanceIndex >= ${particleCount}u) {
          output.position = vec4f(3.0, 3.0, 0.0, 1.0);
          output.local = vec2f(0.0);
          output.strength = 0.0;
          output.drying = 1.0;
          output.retreatVariation = 0.0;
          output.pigmentConcentration = 0.0;
          output.pigmentCoordinates = vec2f(0.0);
          output.paperUv = vec2f(0.0);
          return output;
        }
        let particle = particles[instanceIndex];
        let localIndex = instanceIndex % ${particlesPerRing}u;
        let ringStart = instanceIndex - localIndex;
        let neighbourIndex = ringStart + (localIndex + 1u) % ${particlesPerRing}u;
        let neighbour = particles[neighbourIndex];
        let ring = rings[particle.ringIndex];
        let age = frame.now - ring.birth;
        if (particle.alive == 0u || neighbour.alive == 0u || ring.enabled == 0u ||
            age < 0.0 || age > ${sourceLifetime.toFixed(1)}) {
          output.position = vec4f(3.0, 3.0, 0.0, 1.0);
          output.local = vec2f(0.0);
          output.strength = 0.0;
          output.drying = 1.0;
          output.retreatVariation = 0.0;
          output.pigmentConcentration = 0.0;
          output.pigmentCoordinates = vec2f(0.0);
          output.paperUv = vec2f(0.0);
          return output;
        }

        let canvasAspect = frame.canvasSize.x / frame.canvasSize.y;
        let visibleHeight = min(1.0, frame.aspect / canvasAspect);
        let visibleSize = vec2f(visibleHeight * canvasAspect, visibleHeight);
        let worldPerPixel = visibleSize.x / frame.canvasSize.x;
        let corner = corners[vertexIndex];
        let particlePosition = frontPositions[instanceIndex];
        let neighbourPosition = frontPositions[neighbourIndex];
        let endpointPosition = mix(particlePosition, neighbourPosition, corner.y);
        let endpointRadial = mix(
          length(particlePosition - ring.center),
          length(neighbourPosition - ring.center),
          corner.y
        );
        let particleNormal = frontNormal(
          instanceIndex,
          ringStart,
          ring.center,
          particlePosition
        );
        let neighbourNormal = frontNormal(
          neighbourIndex,
          ringStart,
          ring.center,
          neighbourPosition
        );
        let mixedNormal = mix(particleNormal, neighbourNormal, corner.y);
        var endpointNormal = normalize(endpointPosition - ring.center);
        if (length(mixedNormal) > 0.0001) {
          endpointNormal = normalize(mixedNormal);
        }
        let trailLength = min(
          max(worldPerPixel * 68.0, 0.06),
          max(endpointRadial, worldPerPixel * 1.5)
        );
        let worldPosition = endpointPosition + endpointNormal * corner.x * trailLength;
        let clip = (worldPosition - vec2f(frame.aspect * 0.5, 0.5)) * 2.0 / visibleSize;
        output.position = vec4f(clip, 0.0, 1.0);
        output.local = corner;
        output.strength = ring.strength;
        output.drying = smoothstep(0.0, ${propagationDuration.toFixed(1)}, age);
        // Every strip endpoint has corner.y equal to exactly 0 or 1.  Avoid
        // evaluating the expensive angular fields for the endpoint we discard.
        if (corner.y < 0.5) {
          output.retreatVariation = retreatVariation(particle.angle / TAU, ring.seed);
          output.pigmentConcentration = pigmentConcentration(particle.angle / TAU, ring.seed);
        } else {
          output.retreatVariation = retreatVariation(neighbour.angle / TAU, ring.seed);
          output.pigmentConcentration = pigmentConcentration(neighbour.angle / TAU, ring.seed);
        }
        let particleTurn = particle.angle / TAU;
        var neighbourTurn = neighbour.angle / TAU;
        if (neighbourTurn < particleTurn) { neighbourTurn += 1.0; }
        output.pigmentCoordinates = vec2f(
          mix(particleTurn, neighbourTurn, corner.y),
          ring.seed
        );
        output.paperUv = worldPosition / vec2f(frame.aspect, 1.0) * 2.3;
        return output;
      }

      @fragment
      fn fragmentMain(input: VertexOutput) -> @location(0) vec4f {
        let rear = smoothstep(-1.0, -0.86, input.local.x);
        let front = 1.0 - smoothstep(0.04, 0.18, input.local.x);
        let dryingFront = mix(-1.15, 0.26, input.drying);
        let retreatEnvelope = 1.0 - smoothstep(0.86, 1.0, input.drying);
        let turn = input.pigmentCoordinates.x;
        let pigmentSeed = input.pigmentCoordinates.y;
        // Evaluate the fine edge in fragments so particle spacing cannot flatten it.
        let edgeWarp = (periodicNoise(turn, 17u, pigmentSeed + 701.3) - 0.5) * 0.022;
        let edgeDetail = periodicNoise(turn + edgeWarp, 79u, pigmentSeed + 739.1) - 0.5;
        let edgeFibre = periodicNoise(turn + edgeWarp + edgeDetail * 0.006,
          157u, pigmentSeed + 773.7) - 0.5;
        let retreatEdge = dryingFront +
          (input.retreatVariation + edgeDetail * 0.11 + edgeFibre * 0.045) * retreatEnvelope;
        let edgeSoftness = mix(0.035, 0.075,
          periodicNoise(turn, 31u, pigmentSeed + 809.2));
        let pigmentRemaining = smoothstep(
          retreatEdge - edgeSoftness,
          retreatEdge + edgeSoftness * 0.75,
          input.local.x
        );
        let washFlow = periodicNoise(
          fract(input.pigmentCoordinates.x + input.local.x * 0.028),
          19u,
          input.pigmentCoordinates.y + 593.4
        );
        let washBreakup = periodicNoise(
          fract(input.pigmentCoordinates.x - input.local.x * 0.059),
          47u,
          input.pigmentCoordinates.y + 647.1
        );
        let cloudPosition = input.paperUv * vec2f(22.0, 16.0);
        let cloudCell = floor(cloudPosition);
        let cloudFraction = fract(cloudPosition);
        let cloudBlend = cloudFraction * cloudFraction * (3.0 - 2.0 * cloudFraction);
        let cloud = mix(
          mix(hash(dot(cloudCell, vec2f(1.0, 57.0))),
              hash(dot(cloudCell + vec2f(1.0, 0.0), vec2f(1.0, 57.0))), cloudBlend.x),
          mix(hash(dot(cloudCell + vec2f(0.0, 1.0), vec2f(1.0, 57.0))),
              hash(dot(cloudCell + vec2f(1.0, 1.0), vec2f(1.0, 57.0))), cloudBlend.x),
          cloudBlend.y
        );
        let washDensity = 0.50 + washFlow * 0.20 + washBreakup * 0.08 + cloud * 0.55;
        let paperValue = textureSample(paper, paperSampler, input.paperUv).r;
        // Supplying the mip level keeps this overload accepted by older WGSL
        // implementations, including Safari's WebGPU compiler.
        let paperSize = vec2f(textureDimensions(paper, 0u));
        let paperStep = 3.0 / paperSize;
        let surroundingPaper = (
          textureSample(paper, paperSampler, input.paperUv + vec2f(paperStep.x, 0.0)).r +
          textureSample(paper, paperSampler, input.paperUv - vec2f(paperStep.x, 0.0)).r +
          textureSample(paper, paperSampler, input.paperUv + vec2f(0.0, paperStep.y)).r +
          textureSample(paper, paperSampler, input.paperUv - vec2f(0.0, paperStep.y)).r
        ) * 0.25;
        let localPit = smoothstep(0.012, 0.05, surroundingPaper - paperValue);
        let darkPore = 1.0 - smoothstep(0.59, 0.67, paperValue);
        let paperResistance = clamp(darkPore * 0.9, 0.0, 1.0);
        // Wash settles into hollows; the darker exposed tooth still limits
        // coverage so the paper remains visibly white between strokes.
        let washDeposition = clamp(1.0 + localPit * 0.24 - paperResistance * 0.58, 0.25, 1.18);
        let tideDeposition = clamp(1.0 + localPit * 0.18 - paperResistance * 0.64, 0.20, 1.12);
        let wash = rear * front * 0.42 * washDensity * input.strength *
          pigmentRemaining * washDeposition;
        let tideWidth = select(mix(0.23, 0.38, cloud), 0.16, input.local.x >= 0.0);
        let tideFalloff = select(1.45, 2.0, input.local.x >= 0.0);
        let tideDistance = abs(input.local.x) / tideWidth;
        let tideProfile = exp(-pow(tideDistance, tideFalloff));
        // As water retreats, a restrained amount of pigment gathers at the
        // tide line without changing the broad wash colour.
        let dryingTide = mix(1.0, 1.06, smoothstep(0.5, 1.0, input.drying));
        let tideDensity = (0.60 + input.pigmentConcentration * 0.48) * dryingTide;
        let tide = tideProfile * 0.94 * tideDensity * input.strength *
          pigmentRemaining * tideDeposition;
        return vec4f(wash, tide, 0.0, 0.0);
      }
    `;

    const compositeCode = `
      struct VertexOutput {
        @builtin(position) position: vec4f,
        @location(0) uv: vec2f,
      };

      @group(0) @binding(0) var intensityTexture: texture_2d<f32>;
      @group(0) @binding(1) var intensitySampler: sampler;

      @vertex
      fn vertexMain(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
        let positions = array<vec2f, 3>(
          vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0)
        );
        let point = positions[vertexIndex];
        var output: VertexOutput;
        output.position = vec4f(point, 0.0, 1.0);
        output.uv = point * vec2f(0.5, -0.5) + vec2f(0.5);
        return output;
      }

      @fragment
      fn fragmentMain(input: VertexOutput) -> @location(0) vec4f {
        let intensity = textureSample(intensityTexture, intensitySampler, input.uv).rg;
        let wash = intensity.r;
        let tide = intensity.g;
        let paleBlue = vec3f(0.76, 0.92, 1.0);
        let wetBlue = vec3f(0.59, 0.82, 1.0);
        let tideBlue = vec3f(0.38, 0.68, 1.0);
        var colour = mix(paleBlue, wetBlue, smoothstep(0.04, 0.42, wash) * 0.55);
        colour = mix(colour, tideBlue, smoothstep(0.08, 0.94, tide) * 0.72);
        let alpha = clamp(max(wash * 1.12, tide * 0.62), 0.0, 0.94);
        return vec4f(colour * alpha, alpha);
      }
    `;

    const computeLayout = device.createBindGroupLayout({
      label: "watercolour compute layout",
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
        { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
        { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
        { binding: 6, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "float" } },
        { binding: 7, visibility: GPUShaderStage.COMPUTE, sampler: { type: "filtering" } }
      ]
    });
    const drawLayout = device.createBindGroupLayout({
      label: "watercolour particle draw layout",
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: "uniform" } },
        { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } },
        { binding: 2, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } },
        { binding: 3, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } },
        { binding: 4, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
        { binding: 5, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } }
      ]
    });
    const compositeLayout = device.createBindGroupLayout({
      label: "watercolour composite layout",
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } }
      ]
    });

    async function createCheckedShader(label, code) {
      const module = device.createShaderModule({ label, code });
      const compilation = await module.getCompilationInfo();
      const errors = compilation.messages.filter(message => message.type === "error");
      if (errors.length) {
        const details = errors.map(error => `${error.lineNum}:${error.linePos} ${error.message}`).join("; ");
        throw new Error(`${label}: ${details}`);
      }
      return module;
    }

    const [computeModule, drawModule, compositeModule] = await Promise.all([
      createCheckedShader("watercolour particle compute", computeCode),
      createCheckedShader("watercolour particle draw", drawCode),
      createCheckedShader("watercolour composite", compositeCode)
    ]);
    const computePipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [computeLayout] });
    const maxBlend = {
      color: { srcFactor: "one", dstFactor: "one", operation: "max" },
      alpha: { srcFactor: "one", dstFactor: "one", operation: "max" }
    };

    const [clearPipeline, advancePipeline, reconstructPipeline, fillPipeline, collisionPipeline, applyCollisionPipeline, constraintPipeline, applyConstraintPipeline, drawPipeline, compositePipeline] = await Promise.all([
      device.createComputePipelineAsync({ layout: computePipelineLayout, compute: { module: computeModule, entryPoint: "clearSpatialData" } }),
      device.createComputePipelineAsync({ layout: computePipelineLayout, compute: { module: computeModule, entryPoint: "advance" } }),
      device.createComputePipelineAsync({ layout: computePipelineLayout, compute: { module: computeModule, entryPoint: "reconstructFront" } }),
      device.createComputePipelineAsync({ layout: computePipelineLayout, compute: { module: computeModule, entryPoint: "fillGrid" } }),
      device.createComputePipelineAsync({ layout: computePipelineLayout, compute: { module: computeModule, entryPoint: "detectCollisions" } }),
      device.createComputePipelineAsync({ layout: computePipelineLayout, compute: { module: computeModule, entryPoint: "applyCollisions" } }),
      device.createComputePipelineAsync({ layout: computePipelineLayout, compute: { module: computeModule, entryPoint: "calculateConstraints" } }),
      device.createComputePipelineAsync({ layout: computePipelineLayout, compute: { module: computeModule, entryPoint: "applyConstraints" } }),
      device.createRenderPipelineAsync({
        layout: device.createPipelineLayout({ bindGroupLayouts: [drawLayout] }),
        vertex: { module: drawModule, entryPoint: "vertexMain" },
        fragment: {
          module: drawModule,
          entryPoint: "fragmentMain",
          targets: [{ format: "rgba8unorm", blend: maxBlend }]
        },
        primitive: { topology: "triangle-list" }
      }),
      device.createRenderPipelineAsync({
        layout: device.createPipelineLayout({ bindGroupLayouts: [compositeLayout] }),
        vertex: { module: compositeModule, entryPoint: "vertexMain" },
        fragment: { module: compositeModule, entryPoint: "fragmentMain", targets: [{ format }] },
        primitive: { topology: "triangle-list" }
      })
    ]);

    const computeBindGroup = device.createBindGroup({
      layout: computeLayout,
      entries: [
        { binding: 0, resource: { buffer: frameBuffer } },
        { binding: 1, resource: { buffer: particleBuffer } },
        { binding: 2, resource: { buffer: ringBuffer } },
        { binding: 3, resource: { buffer: occupancyBuffer } },
        { binding: 4, resource: { buffer: collisionBuffer } },
        { binding: 5, resource: { buffer: frontBuffer } },
        { binding: 6, resource: paperTexture.createView() },
        { binding: 7, resource: paperSampler }
      ]
    });
    const drawBindGroup = device.createBindGroup({
      layout: drawLayout,
      entries: [
        { binding: 0, resource: { buffer: frameBuffer } },
        { binding: 1, resource: { buffer: particleBuffer } },
        { binding: 2, resource: { buffer: ringBuffer } },
        { binding: 3, resource: { buffer: frontBuffer } },
        { binding: 4, resource: paperTexture.createView() },
        { binding: 5, resource: paperSampler }
      ]
    });
    const intensitySampler = device.createSampler({ magFilter: "linear", minFilter: "linear" });
    let intensityTexture;
    let compositeBindGroup;

    function rebuildIntensityTargets() {
      intensityTexture?.destroy();
      intensityTexture = device.createTexture({
        label: "watercolour wash and tide intensity",
        size: [canvas.width, canvas.height],
        format: "rgba8unorm",
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING
      });
      compositeBindGroup = device.createBindGroup({
        layout: compositeLayout,
        entries: [
          { binding: 0, resource: intensityTexture.createView() },
          { binding: 1, resource: intensitySampler }
        ]
      });
    }

    function writeFrame(now, delta, activeParticleCount) {
      frameFloats[0] = now;
      frameFloats[1] = delta;
      frameFloats[2] = stateAspect;
      frameUints[3] = activeParticleCount;
      frameFloats[4] = canvas.width;
      frameFloats[5] = canvas.height;
      frameUints[6] = gridWidth;
      frameUints[7] = gridHeight;
      device.queue.writeBuffer(frameBuffer, 0, frameBacking);
    }

    function expireRings(now) {
      let changed = false;
      for (let slot = 0; slot < ringCapacity; slot++) {
        const ring = ringSlots[slot];
        if (ring && ring.active && now - ring.birth > sourceLifetime) {
          ring.active = false;
          ringUints[slot * 8 + 7] = 0;
          changed = true;
        }
      }
      if (changed) device.queue.writeBuffer(ringBuffer, 0, ringBacking);
    }

    function drawFrame(now, delta) {
      if (paused || simulationDisabled() || (frameInFlight && !reducedMotion) || !intensityTexture) return false;
      expireRings(now);
      let activeParticleCount = 0;
      for (let slot = ringCapacity - 1; slot >= 0; slot--) {
        if (ringSlots[slot]?.active) {
          activeParticleCount = (slot + 1) * particlesPerRing;
          break;
        }
      }
      writeFrame(now, delta, activeParticleCount);
      const encoder = device.createCommandEncoder({ label: "watercolour frame" });

      let pass = encoder.beginComputePass();
      pass.setBindGroup(0, computeBindGroup);
      if (activeParticleCount > 0) {
        const particleWorkgroups = Math.ceil(activeParticleCount / 128);
        const clearWorkgroups = Math.ceil(Math.max(gridEntryCount, particleCount) / 256);
        pass.setPipeline(advancePipeline);
        pass.dispatchWorkgroups(particleWorkgroups);
        for (let iteration = 0; iteration < collisionIterations; iteration++) {
          pass.setPipeline(clearPipeline);
          pass.dispatchWorkgroups(clearWorkgroups);
          pass.setPipeline(reconstructPipeline);
          pass.dispatchWorkgroups(particleWorkgroups);
          pass.setPipeline(fillPipeline);
          pass.dispatchWorkgroups(particleWorkgroups);
          pass.setPipeline(collisionPipeline);
          pass.dispatchWorkgroups(particleWorkgroups);
          pass.setPipeline(applyCollisionPipeline);
          pass.dispatchWorkgroups(particleWorkgroups);
        }
        pass.setPipeline(constraintPipeline);
        pass.dispatchWorkgroups(particleWorkgroups);
        pass.setPipeline(applyConstraintPipeline);
        pass.dispatchWorkgroups(particleWorkgroups);
        pass.setPipeline(reconstructPipeline);
        pass.dispatchWorkgroups(particleWorkgroups);
      }
      pass.end();

      pass = encoder.beginRenderPass({
        colorAttachments: [{
          view: intensityTexture.createView(),
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
          loadOp: "clear",
          storeOp: "store"
        }]
      });
      pass.setPipeline(drawPipeline);
      pass.setBindGroup(0, drawBindGroup);
      pass.draw(6, activeParticleCount);
      pass.end();

      pass = encoder.beginRenderPass({
        colorAttachments: [{
          view: context.getCurrentTexture().createView(),
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
          loadOp: "clear",
          storeOp: "store"
        }]
      });
      pass.setPipeline(compositePipeline);
      pass.setBindGroup(0, compositeBindGroup);
      pass.draw(3);
      pass.end();
      device.queue.submit([encoder.finish()]);
      window.paintPosterWatercolour?.(canvas);
      frameInFlight = true;
      lastSubmitTime = performance.now();
      const completion = device.queue.onSubmittedWorkDone?.() || Promise.resolve();
      completion.catch(() => {}).then(() => {
        frameInFlight = false;
        scheduleFrame(Math.max(0, 1000 / 24 - (performance.now() - lastSubmitTime)));
      });
      return true;
    }

    function initializeParticles(slot, ring, initialAge) {
      const backing = new ArrayBuffer(particlesPerRing * particleStride);
      const floats = new Float32Array(backing);
      const uints = new Uint32Array(backing);
      const initialProgress = Math.min(Math.max(initialAge / propagationDuration, 0), 1);
      const initialRadius = Math.max(0.0002, ring.radius * Math.sin(initialProgress * Math.PI * 0.5));
      const initialVelocity = ring.radius * (Math.PI * 0.5 / propagationDuration) *
        Math.max(Math.cos(initialProgress * Math.PI * 0.5), 0);
      for (let index = 0; index < particlesPerRing; index++) {
        const word = index * 10;
        const angle = index / particlesPerRing * Math.PI * 2;
        floats[word] = ring.x + Math.cos(angle) * initialRadius;
        floats[word + 1] = ring.y + Math.sin(angle) * initialRadius;
        floats[word + 2] = initialRadius;
        floats[word + 3] = angle;
        floats[word + 4] = 0;
        floats[word + 5] = random() * 1000;
        uints[word + 6] = 0;
        floats[word + 7] = initialVelocity;
        uints[word + 8] = 1;
        uints[word + 9] = slot;
      }
      device.queue.writeBuffer(particleBuffer, slot * particlesPerRing * particleStride, backing);
    }

    function writeRing(slot, ring) {
      const word = slot * 8;
      ringFloats[word] = ring.x;
      ringFloats[word + 1] = ring.y;
      ringFloats[word + 2] = ring.birth;
      ringFloats[word + 3] = ring.radius;
      ringFloats[word + 4] = ring.strength;
      ringFloats[word + 5] = ring.seed;
      ringUints[word + 6] = ring.group;
      ringUints[word + 7] = 1;
      ringSlots[slot] = ring;
    }

    function addSplash(point, radius = 0.235, instant = false) {
      const now = performance.now() / 1000;
      const group = nextGroup++;
      const delays = [0, 1.9, 3.7];
      const strengths = [1, 0.88, 0.8];
      const staticAges = [7.8, 4.8, 2.0];
      expireRings(now);
      const freeSlots = [];
      for (let slot = 0; slot < ringCapacity && freeSlots.length < delays.length; slot++) {
        if (!ringSlots[slot]?.active) freeSlots.push(slot);
      }
      if (freeSlots.length < delays.length) return;
      for (let wave = 0; wave < 3; wave++) {
        const initialAge = instant ? staticAges[wave] : 0;
        const ring = {
          x: point.x,
          y: point.y,
          birth: instant ? now - initialAge : now + delays[wave],
          radius,
          strength: strengths[wave],
          seed: random() * 997,
          group,
          active: true
        };
        const slot = freeSlots[wave];
        writeRing(slot, ring);
        initializeParticles(slot, ring, initialAge);
      }
      device.queue.writeBuffer(ringBuffer, 0, ringBacking);
    }

    function canvasPosition(clientX, clientY) {
      const bounds = canvas.getBoundingClientRect();
      const point = {
        x: Math.max(0, Math.min(1, (clientX - bounds.left) / bounds.width)),
        y: 1 - Math.max(0, Math.min(1, (clientY - bounds.top) / bounds.height))
      };
      const canvasAspect = bounds.width / bounds.height;
      if (canvasAspect > stateAspect) {
        const height = stateAspect / canvasAspect;
        point.y = (1 - height) * 0.5 + point.y * height;
      } else {
        const width = canvasAspect / stateAspect;
        point.x = (1 - width) * 0.5 + point.x * width;
      }
      return { x: point.x * stateAspect, y: point.y };
    }

    function addRandomSplash() {
      if (!receipt) return;
      const receiptBounds = receipt.getBoundingClientRect();
      const inset = 20;
      const regions = [
        { left: inset, right: receiptBounds.left - inset, top: inset, bottom: innerHeight - inset },
        { left: receiptBounds.right + inset, right: innerWidth - inset, top: inset, bottom: innerHeight - inset },
        { left: inset, right: innerWidth - inset, top: inset, bottom: receiptBounds.top - inset },
        { left: inset, right: innerWidth - inset, top: receiptBounds.bottom + inset, bottom: innerHeight - inset }
      ].filter(region => region.right - region.left > 32 && region.bottom - region.top > 32);
      if (!regions.length) return;
      const region = regions[automaticRegionIndex++ % regions.length];
      addSplash(canvasPosition(
        region.left + random() * (region.right - region.left),
        region.top + random() * (region.bottom - region.top)
      ), 0.21 + random() * 0.055);
    }

    function resizeCanvas() {
      const cssWidth = Math.max(1, canvas.clientWidth);
      const cssHeight = Math.max(1, canvas.clientHeight);
      const requestedScale = Math.min(window.devicePixelRatio || 1, isSafari ? 1 : 1.25);
      const maximumDimension = isSafari ? 1200 : 1400;
      const fittedScale = Math.min(requestedScale, maximumDimension / Math.max(cssWidth, cssHeight));
      const width = Math.max(1, Math.round(cssWidth * fittedScale));
      const height = Math.max(1, Math.round(cssHeight * fittedScale));
      if (canvas.width === width && canvas.height === height && intensityTexture) return false;
      canvas.width = width;
      canvas.height = height;
      rebuildIntensityTargets();
      drawFrame(performance.now() / 1000, 0);
      return true;
    }

    document.addEventListener("click", event => {
      if (simulationDisabled()) return;
      if (receipt?.contains(event.target)) return;
      addSplash(canvasPosition(event.clientX, event.clientY), 0.235, reducedMotion);
      if (reducedMotion) drawFrame(performance.now() / 1000, 0);
    });
    window.addEventListener("resize", resizeCanvas, { passive: true });

    function scheduleFrame(delay = 1000 / 24) {
      if (reducedMotion || paused || frameTimer !== null) return;
      frameTimer = window.setTimeout(() => {
        frameTimer = null;
        const timestamp = performance.now();
        const delta = Math.min(Math.max((timestamp - lastFrame) / 1000, 0), 0.1);
        lastFrame = timestamp;
        if (!paused && timestamp >= nextAutomaticSplash) {
          addRandomSplash();
          nextAutomaticSplash = timestamp + automaticSplashInterval;
        }
        drawFrame(timestamp / 1000, delta);
      }, Math.max(0, Math.ceil(delay)));
    }

    function updatePauseState() {
      const shouldPause = document.hidden || simulationDisabled();
      if (shouldPause) {
        paused = true;
        if (frameTimer !== null) {
          window.clearTimeout(frameTimer);
          frameTimer = null;
        }
        return;
      }
      paused = false;
      lastFrame = performance.now();
      nextAutomaticSplash = lastFrame + automaticSplashInterval;
      const resized = resizeCanvas();
      if (reducedMotion) {
        if (!resized) drawFrame(lastFrame / 1000, 0);
      } else {
        scheduleFrame(0);
      }
    }

    document.addEventListener("visibilitychange", updatePauseState);
    document.addEventListener("simpleviewchange", updatePauseState);
    smallDevice.addEventListener?.("change", updatePauseState);

    device.queue.writeBuffer(ringBuffer, 0, ringBacking);
    resizeCanvas();
    if (reducedMotion) return;

    scheduleFrame(0);
  }

  let started = false;
  function startIfEnabled() {
    if (started || simulationDisabled()) return;
    started = true;
    start().catch(error => unavailable("WebGPU initialization failed.", error));
  }
  document.addEventListener("simpleviewchange", startIfEnabled);
  startIfEnabled();
})();
