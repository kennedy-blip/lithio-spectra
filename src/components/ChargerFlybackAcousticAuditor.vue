<script setup>
import { ref, computed, watch, onMounted, nextTick } from 'vue';
import {
  CHARGER_PRESETS,
  synthesizeChargerSpectrum,
  analyzeLiveUltrasonicBuffer
} from '../engines/chargerFlybackForensicsEngine.js';
import { saveDiagnosticRecord } from '../db/lithioVaultDb.js';

const emit = defineEmits(['record-saved']);

const selectedPresetId = ref(CHARGER_PRESETS[1].id);
const gridHz = ref(60);
const capturing = ref(false);
const liveAnalysis = ref(null);
const sourceMode = ref('Flyback Forensics Simulator');
const savedNotice = ref('');
const spectrumCanvas = ref(null);

const selectedPreset = computed(
  () => CHARGER_PRESETS.find((p) => p.id === selectedPresetId.value) || CHARGER_PRESETS[0]
);

const analysis = computed(
  () => liveAnalysis.value || synthesizeChargerSpectrum(selectedPreset.value, gridHz.value)
);

function selectPreset(id) {
  liveAnalysis.value = null;
  sourceMode.value = 'Flyback Forensics Simulator';
  selectedPresetId.value = id;
}

async function captureLiveChargerAudio() {
  if (!navigator.mediaDevices?.getUserMedia) return;
  capturing.value = true;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
    });
    const ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 });
    const src = ctx.createMediaStreamSource(stream);
    const proc = ctx.createScriptProcessor(4096, 1, 1);
    const samples = [];
    proc.onaudioprocess = (e) => {
      samples.push(...e.inputBuffer.getChannelData(0));
      if (samples.length >= 4096) {
        proc.disconnect();
        src.disconnect();
        stream.getTracks().forEach((t) => t.stop());
        ctx.close();
        liveAnalysis.value = analyzeLiveUltrasonicBuffer(samples.slice(0, 4096), 48000, gridHz.value);
        sourceMode.value = 'Live 48 kHz Unprocessed Mic Capture';
        capturing.value = false;
        nextTick(drawSpectrum);
      }
    };
    src.connect(proc);
    proc.connect(ctx.destination);
  } catch {
    capturing.value = false;
  }
}

function drawSpectrum() {
  const canvas = spectrumCanvas.value;
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = Math.max(320, Math.round(rect.width || 620));
  const h = Math.max(220, Math.round(rect.height || 265));
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const bins = analysis.value.bins;
  const pad = { l: 46, r: 18, t: 24, b: 30 };
  const pw = w - pad.l - pad.r;
  const ph = h - pad.t - pad.b;

  ctx.strokeStyle = 'rgba(148,163,184,0.16)';
  for (let i = 0; i <= 4; i++) {
    const y = pad.t + (ph * i) / 4;
    ctx.beginPath();
    ctx.moveTo(pad.l, y);
    ctx.lineTo(w - pad.r, y);
    ctx.stroke();
    ctx.fillStyle = '#94a3b8';
    ctx.font = '10px JetBrains Mono, monospace';
    ctx.fillText(`${-i * 18} dB`, 6, y + 3);
  }

  // Spectrum bar + line fill
  ctx.beginPath();
  bins.forEach((b, idx) => {
    const x = pad.l + (idx / Math.max(1, bins.length - 1)) * pw;
    const norm = Math.max(0, Math.min(1, (b.magDb + 75) / 72));
    const y = pad.t + ph - norm * ph;
    if (idx === 0) ctx.moveTo(x, pad.t + ph);
    ctx.lineTo(x, y);
  });
  ctx.lineTo(pad.l + pw, pad.t + ph);
  ctx.closePath();
  ctx.fillStyle =
    analysis.value.riskClass === 'DANGER'
      ? 'rgba(244, 63, 94, 0.20)'
      : analysis.value.riskClass === 'WARN'
        ? 'rgba(245, 158, 11, 0.20)'
        : 'rgba(16, 185, 129, 0.20)';
  ctx.fill();

  ctx.beginPath();
  bins.forEach((b, idx) => {
    const x = pad.l + (idx / Math.max(1, bins.length - 1)) * pw;
    const norm = Math.max(0, Math.min(1, (b.magDb + 75) / 72));
    const y = pad.t + ph - norm * ph;
    if (idx === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.strokeStyle =
    analysis.value.riskClass === 'DANGER'
      ? '#f43f5e'
      : analysis.value.riskClass === 'WARN'
        ? '#f59e0b'
        : '#10b981';
  ctx.lineWidth = 2.4;
  ctx.stroke();

  ctx.fillStyle = '#94a3b8';
  ctx.font = '10px JetBrains Mono, monospace';
  ctx.fillText('SMPS Flyback Magnetostriction & Mains Hum Spectrum (100 Hz – 23.5 kHz)', pad.l, 14);
  ctx.fillText('100 Hz', pad.l, h - 8);
  ctx.fillText('12 kHz', pad.l + pw * 0.5, h - 8);
  ctx.fillText('23.5 kHz', w - 58, h - 8);
}

async function saveToVault() {
  await saveDiagnosticRecord('charger_forensics_logs', {
    preset: selectedPreset.value.label,
    source: sourceMode.value,
    grade: analysis.value.grade,
    rippleMvpp: analysis.value.rippleMvpp,
    jitterEntropy: analysis.value.jitterEntropy,
    carrierHz: analysis.value.carrierHz
  });
  savedNotice.value = 'Charger Forensics Audit Saved';
  emit('record-saved');
  setTimeout(() => (savedNotice.value = ''), 3200);
}

watch([analysis, gridHz], () => nextTick(drawSpectrum), { deep: true });
onMounted(() => nextTick(drawSpectrum));
</script>

<template>
  <div class="lab-grid">
    <div class="glass-card panel-pad col-12">
      <div class="section-header">
        <div>
          <h2 class="section-title">
            <span>Module 4 · Counterfeit / Unsafe USB-C PD &amp; GaN Charger Forensics</span>
            <span class="badge" :class="analysis.riskClass === 'DANGER' ? 'badge-crimson' : analysis.riskClass === 'WARN' ? 'badge-amber' : 'badge-emerald'">
              {{ analysis.grade }}
            </span>
          </h2>
          <p class="section-subtitle">
            Captures 48 kHz inductor magnetostriction (12–22 kHz), 100/120 Hz mains hum sidebands, and transformer leakage EMF (uT).
          </p>
        </div>
        <div style="display: flex; gap: 8px; flex-wrap: wrap;">
          <button class="pill-btn" :class="{ active: gridHz === 60 }" @click="gridHz = 60">60 Hz Grid (120 Hz Hum)</button>
          <button class="pill-btn" :class="{ active: gridHz === 50 }" @click="gridHz = 50">50 Hz Grid (100 Hz Hum)</button>
          <button class="pill-btn active" @click="captureLiveChargerAudio" :disabled="capturing">
            {{ capturing ? 'Sampling 48 kHz Mic...' : 'Live Mic Brick Audit' }}
          </button>
          <button class="pill-btn" @click="saveToVault">Save Audit</button>
        </div>
      </div>

      <div class="preset-strip">
        <button
          v-for="p in CHARGER_PRESETS"
          :key="p.id"
          class="pill-btn"
          :class="{ active: selectedPresetId === p.id && !liveAnalysis }"
          @click="selectPreset(p.id)"
        >
          {{ p.shortName }}
        </button>
      </div>

      <div v-if="savedNotice" class="badge badge-emerald" style="margin-bottom: 10px;">{{ savedNotice }}</div>

      <div class="kpi-grid">
        <div class="kpi-tile">
          <div class="kpi-label">Est. Output Voltage Ripple</div>
          <div class="kpi-val" :style="{ color: analysis.rippleMvpp > 200 ? 'var(--accent-crimson)' : 'var(--accent-emerald)' }">
            {{ analysis.rippleMvpp }} mVpp
          </div>
          <div class="kpi-sub">USB-PD spec target &lt; 100 mVpp</div>
        </div>
        <div class="kpi-tile">
          <div class="kpi-label">Flyback Carrier Peak</div>
          <div class="kpi-val">{{ (analysis.carrierHz / 1000).toFixed(2) }} kHz</div>
          <div class="kpi-sub">{{ analysis.mainsHumHz }} Hz Hum Mod: {{ analysis.modulationIndexPct }}%</div>
        </div>
        <div class="kpi-tile">
          <div class="kpi-label">Jitter Spectral Entropy</div>
          <div class="kpi-val" :style="{ color: analysis.jitterEntropy > 0.65 ? 'var(--accent-crimson)' : 'var(--accent-cyan)' }">
            {{ analysis.jitterEntropy }}
          </div>
          <div class="kpi-sub">&lt;0.25 Digital PWM · &gt;0.65 Crude RCC</div>
        </div>
        <div class="kpi-tile">
          <div class="kpi-label">Stray Magnetic Flux (EMF)</div>
          <div class="kpi-val">{{ analysis.magLeakageUt }} µT</div>
          <div class="kpi-sub">AC Ripple: {{ analysis.magAcRippleUt }} µT RMS</div>
        </div>
      </div>
    </div>

    <div class="glass-card glass-interactive panel-pad col-12">
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; flex-wrap: wrap; gap: 8px;">
        <span class="mono" style="font-size: 0.76rem; color: var(--text-secondary);">
          <strong>Source:</strong> {{ sourceMode }} · <strong>Topology:</strong> {{ selectedPreset.topology }}
        </span>
      </div>
      <canvas ref="spectrumCanvas" class="chart-canvas chart-canvas-tall"></canvas>
      <p style="margin: 10px 0 0; font-size: 0.78rem; color: var(--text-secondary);">
        {{ selectedPreset.notes }}
      </p>
    </div>
  </div>
</template>
