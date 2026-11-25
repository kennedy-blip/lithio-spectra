<script setup>
import { ref, computed, watch, onMounted, onUnmounted, nextTick } from 'vue';
import moireFragSrc from '../shaders/moireSwellProfilometryShader.glsl?raw';
import {
  POUCH_SWELL_PRESETS,
  solveTimoshenkoGasPressure,
  analyzeAcousticPingResponse
} from '../engines/pouchSwellMoireAcousticEngine.js';
import { saveDiagnosticRecord } from '../db/lithioVaultDb.js';

const emit = defineEmits(['record-saved']);

const selectedPresetId = ref(POUCH_SWELL_PRESETS[1].id);
const bulgeMm = ref(POUCH_SWELL_PRESETS[1].bulgeMm);
const fringePitch = ref(24);
const cellLengthMm = ref(95);
const cellWidthMm = ref(66);

const liveCameraActive = ref(false);
const liveMicActive = ref(false);
const savedNotice = ref('');
const liveAcousticResult = ref(null);

const glCanvas = ref(null);
const videoEl = ref(null);
const acousticCanvas = ref(null);

let gl = null;
let program = null;
let rafId = null;
let videoTex = null;
let cameraStream = null;
let phaseShift = 0;

const selectedPreset = computed(
  () => POUCH_SWELL_PRESETS.find((p) => p.id === selectedPresetId.value) || POUCH_SWELL_PRESETS[0]
);

const timoshenko = computed(() =>
  solveTimoshenkoGasPressure({
    bulgeMm: bulgeMm.value,
    lengthMm: cellLengthMm.value,
    widthMm: cellWidthMm.value,
    wallThicknessMm: selectedPreset.value.wallThicknessMm
  })
);

const acoustic = computed(() => liveAcousticResult.value || analyzeAcousticPingResponse(selectedPreset.value));

function applyPreset(preset) {
  selectedPresetId.value = preset.id;
  bulgeMm.value = preset.bulgeMm;
  cellLengthMm.value = preset.lengthMm;
  cellWidthMm.value = preset.widthMm;
  liveAcousticResult.value = null;
  nextTick(drawAcousticChart);
}

function initWebGlMoire() {
  const canvas = glCanvas.value;
  if (!canvas) return;
  gl = canvas.getContext('webgl2', { antialias: true });
  if (!gl) return;

  const vertSrc = `#version 300 es
    in vec2 a_pos;
    void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }
  `;

  const compile = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    return s;
  };

  const vs = compile(gl.VERTEX_SHADER, vertSrc);
  const fs = compile(gl.FRAGMENT_SHADER, moireFragSrc);
  program = gl.createProgram();
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);

  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(program, 'a_pos');
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

  videoTex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, videoTex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

  const render = (now) => {
    if (!gl || !program) return;
    const rect = canvas.getBoundingClientRect();
    const w = Math.max(320, Math.round(rect.width));
    const h = Math.max(240, Math.round(rect.height));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    gl.viewport(0, 0, w, h);
    gl.useProgram(program);

    phaseShift += 0.018;
    if (liveCameraActive.value && videoEl.value && videoEl.value.readyState >= 2) {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, videoTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, videoEl.value);
      gl.uniform1i(gl.getUniformLocation(program, 'u_video_tex'), 0);
    }

    gl.uniform2f(gl.getUniformLocation(program, 'u_resolution'), w, h);
    gl.uniform1f(gl.getUniformLocation(program, 'u_time'), now * 0.001);
    gl.uniform1f(gl.getUniformLocation(program, 'u_bulge_mm'), bulgeMm.value);
    gl.uniform1f(gl.getUniformLocation(program, 'u_fringe_pitch'), fringePitch.value);
    gl.uniform1f(gl.getUniformLocation(program, 'u_phase_shift'), phaseShift);
    gl.uniform1f(gl.getUniformLocation(program, 'u_has_video'), liveCameraActive.value ? 1.0 : 0.0);

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    rafId = requestAnimationFrame(render);
  };
  rafId = requestAnimationFrame(render);
}

async function toggleLiveCamera() {
  if (liveCameraActive.value) {
    cameraStream?.getTracks().forEach((t) => t.stop());
    cameraStream = null;
    liveCameraActive.value = false;
    return;
  }
  try {
    cameraStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 60 } }
    });
    if (videoEl.value) {
      videoEl.value.srcObject = cameraStream;
      await videoEl.value.play();
    }
    liveCameraActive.value = true;
  } catch {
    liveCameraActive.value = false;
  }
}

async function runLiveAcousticPing() {
  if (!navigator.mediaDevices?.getUserMedia) return;
  liveMicActive.value = true;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
    });
    const ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 });
    const src = ctx.createMediaStreamSource(stream);
    const proc = ctx.createScriptProcessor(4096, 1, 1);
    const collected = [];
    proc.onaudioprocess = (e) => {
      collected.push(...e.inputBuffer.getChannelData(0));
      if (collected.length >= 4096) {
        proc.disconnect();
        src.disconnect();
        stream.getTracks().forEach((t) => t.stop());
        ctx.close();
        liveAcousticResult.value = analyzeAcousticPingResponse(collected.slice(0, 4096), 48000);
        liveMicActive.value = false;
        nextTick(drawAcousticChart);
      }
    };
    src.connect(proc);
    proc.connect(ctx.destination);
  } catch {
    liveMicActive.value = false;
  }
}

function drawAcousticChart() {
  const canvas = acousticCanvas.value;
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = Math.max(300, Math.round(rect.width || 440));
  const h = Math.max(200, Math.round(rect.height || 240));
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const spec = acoustic.value.spectrum;
  const pad = { l: 42, r: 16, t: 24, b: 28 };
  const pw = w - pad.l - pad.r;
  const ph = h - pad.t - pad.b;

  ctx.strokeStyle = 'rgba(148,163,184,0.16)';
  for (let i = 0; i <= 4; i++) {
    const y = pad.t + (ph * i) / 4;
    ctx.beginPath();
    ctx.moveTo(pad.l, y);
    ctx.lineTo(w - pad.r, y);
    ctx.stroke();
  }

  ctx.beginPath();
  spec.forEach((pt, idx) => {
    const x = pad.l + (idx / Math.max(1, spec.length - 1)) * pw;
    const norm = Math.max(0, Math.min(1, (pt.magDb + 65) / 60));
    const y = pad.t + ph - norm * ph;
    if (idx === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.strokeStyle = '#f59e0b';
  ctx.lineWidth = 2.4;
  ctx.stroke();

  ctx.fillStyle = '#94a3b8';
  ctx.font = '10px JetBrains Mono, monospace';
  ctx.fillText('Acoustic Impulse Ping Spectrum (600 Hz – 10 kHz)', pad.l, 14);
  ctx.fillText(`Centroid: ${acoustic.value.centroidHz} Hz`, pad.l, h - 8);
  ctx.fillText(`Zeta: ${acoustic.value.dampingZeta}`, w - 85, h - 8);
}

async function saveToVault() {
  await saveDiagnosticRecord('pouch_swell_scans', {
    preset: selectedPreset.value.label,
    bulgeMm: bulgeMm.value,
    pressureKpa: timoshenko.value.pressureKpa,
    mmolGas: timoshenko.value.mmolGas,
    hazardTier: timoshenko.value.hazardTier,
    centroidHz: acoustic.value.centroidHz
  });
  savedNotice.value = 'Swelling & Acoustic Scan Logged';
  emit('record-saved');
  setTimeout(() => (savedNotice.value = ''), 3200);
}

watch(bulgeMm, () => nextTick(drawAcousticChart));

onMounted(() => {
  initWebGlMoire();
  nextTick(drawAcousticChart);
});

onUnmounted(() => {
  if (rafId) cancelAnimationFrame(rafId);
  cameraStream?.getTracks().forEach((t) => t.stop());
});
</script>

<template>
  <div class="lab-grid">
    <div class="glass-card panel-pad col-12">
      <div class="section-header">
        <div>
          <h2 class="section-title">
            <span>Module 2 · Specular Moiré Swelling Profilometer &amp; Acoustic Ping Scanner</span>
            <span class="badge badge-amber">WebGL2 60 FPS + Timoshenko</span>
          </h2>
          <p class="section-subtitle">
            Detects sub-millimeter "spicy pillow" Z-axis dome deflection (Δz) and internal CO2/C2H4 gas pressure (kPa).
          </p>
        </div>
        <div style="display: flex; gap: 8px; flex-wrap: wrap;">
          <button class="pill-btn" :class="{ active: liveCameraActive }" @click="toggleLiveCamera">
            {{ liveCameraActive ? 'Stop 60 FPS Camera' : 'Bind Live Camera Feed' }}
          </button>
          <button class="pill-btn" :class="{ active: liveMicActive }" @click="runLiveAcousticPing" :disabled="liveMicActive">
            {{ liveMicActive ? 'Listening for Tap...' : 'Capture Live Tap Ping' }}
          </button>
          <button class="pill-btn" @click="saveToVault">Save Scan</button>
        </div>
      </div>

      <div class="preset-strip">
        <button
          v-for="p in POUCH_SWELL_PRESETS"
          :key="p.id"
          class="pill-btn"
          :class="{ active: selectedPresetId === p.id }"
          @click="applyPreset(p)"
        >
          {{ p.shortName }}
        </button>
      </div>

      <div v-if="savedNotice" class="badge badge-emerald" style="margin-bottom: 10px;">{{ savedNotice }}</div>

      <div class="kpi-grid">
        <div class="kpi-tile">
          <div class="kpi-label">Z-Axis Dome Bulge (Δz)</div>
          <div class="kpi-val" :style="{ color: bulgeMm >= 1.5 ? 'var(--accent-crimson)' : 'var(--accent-cyan)' }">
            {{ bulgeMm.toFixed(2) }} mm
          </div>
          <div class="kpi-sub">{{ Math.round(bulgeMm * 1000) }} µm surface deflection</div>
        </div>
        <div class="kpi-tile">
          <div class="kpi-label">Timoshenko Gas Pressure</div>
          <div class="kpi-val" :style="{ color: timoshenko.pressureKpa > 80 ? 'var(--accent-crimson)' : 'var(--accent-amber)' }">
            {{ timoshenko.pressureKpa }} kPa
          </div>
          <div class="kpi-sub">{{ timoshenko.bulgeVolMl }} mL · {{ timoshenko.mmolGas }} mmol gas</div>
        </div>
        <div class="kpi-tile">
          <div class="kpi-label">Acoustic Ping Centroid</div>
          <div class="kpi-val">{{ acoustic.centroidHz }} Hz</div>
          <div class="kpi-sub">Damping ζ = {{ acoustic.dampingZeta }}</div>
        </div>
        <div class="kpi-tile">
          <div class="kpi-label">Gas-Void Delamination</div>
          <div class="kpi-val" :style="{ color: acoustic.gasVoidLikelihoodPct > 55 ? 'var(--accent-crimson)' : 'var(--accent-emerald)' }">
            {{ acoustic.gasVoidLikelihoodPct }}%
          </div>
          <div class="kpi-sub">{{ timoshenko.hazardTier }}</div>
        </div>
      </div>
    </div>

    <div class="glass-card glass-interactive panel-pad col-7">
      <div class="section-header" style="margin-bottom: 8px;">
        <span class="badge badge-cyan">60 FPS WebGL2 Specular Moiré Zebra Grating</span>
        <span class="mono" style="font-size: 0.72rem; color: var(--text-secondary);">
          {{ liveCameraActive ? 'Live Camera Overlay' : 'Synthetic Al-Laminate Plate' }}
        </span>
      </div>
      <video ref="videoEl" style="display: none;" playsinline muted></video>
      <canvas ref="glCanvas" class="chart-canvas chart-canvas-tall"></canvas>

      <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; margin-top: 12px;">
        <div class="slider-group">
          <div class="slider-label">
            <span>Swelling Deflection (Δz)</span>
            <span class="mono">{{ bulgeMm.toFixed(2) }} mm</span>
          </div>
          <input type="range" min="0" max="4.2" step="0.02" v-model.number="bulgeMm" />
        </div>
        <div class="slider-group">
          <div class="slider-label">
            <span>Moiré Grating Pitch</span>
            <span class="mono">{{ fringePitch }} lines</span>
          </div>
          <input type="range" min="12" max="48" step="1" v-model.number="fringePitch" />
        </div>
      </div>
    </div>

    <div class="glass-card glass-interactive panel-pad col-5">
      <div class="section-header" style="margin-bottom: 8px;">
        <span class="badge badge-amber">Acoustic Impulse Bulk Modulus Assay</span>
      </div>
      <canvas ref="acousticCanvas" class="chart-canvas"></canvas>
      <div style="margin-top: 12px; display: grid; grid-template-columns: 1fr 1fr; gap: 10px;">
        <div>
          <label class="kpi-label">Cell Length a (mm)</label>
          <input type="number" v-model.number="cellLengthMm" min="30" max="300" />
        </div>
        <div>
          <label class="kpi-label">Cell Width b (mm)</label>
          <input type="number" v-model.number="cellWidthMm" min="25" max="200" />
        </div>
      </div>
      <p style="margin-top: 10px; font-size: 0.76rem; color: var(--text-secondary);">
        {{ selectedPreset.notes }}
      </p>
    </div>
  </div>
</template>
