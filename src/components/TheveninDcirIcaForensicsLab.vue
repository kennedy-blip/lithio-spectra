<script setup>
import { ref, computed, watch, onMounted, nextTick } from 'vue';
import {
  CELL_PROFILES,
  analyzeCellTheveninAndIca,
  runLiveBrowserLoadPulse
} from '../engines/theveninDcirBatteryEngine.js';
import { useSpringPhysics } from '../composables/useSpringPhysics.js';
import { saveDiagnosticRecord } from '../db/lithioVaultDb.js';

const props = defineProps({
  rbacRole: { type: String, required: true }
});

const emit = defineEmits(['telemetry-pulse', 'record-saved']);

const selectedProfileId = ref(CELL_PROFILES[1].id);
const loadPulseMa = ref(1450);
const customLiveSamples = ref(null);
const pulseRunning = ref(false);
const pulseProgress = ref(0);
const hardwareSourceLabel = ref('Electrochemical Cell Simulator');
const savedNotice = ref('');

const transientCanvas = ref(null);
const nyquistCanvas = ref(null);
const icaCanvas = ref(null);

const selectedProfile = computed(
  () => CELL_PROFILES.find((p) => p.id === selectedProfileId.value) || CELL_PROFILES[0]
);

const analysis = computed(() =>
  analyzeCellTheveninAndIca(selectedProfile.value, customLiveSamples.value, loadPulseMa.value)
);

const dcirSpring = useSpringPhysics(analysis.value.totalDcirMohm, { stiffness: 185, damping: 21 });
const sohSpring = useSpringPhysics(analysis.value.icaMetrics.estimatedSohPct, { stiffness: 185, damping: 21 });

watch(
  analysis,
  (val) => {
    dcirSpring.setTarget(val.totalDcirMohm);
    sohSpring.setTarget(val.icaMetrics.estimatedSohPct);
    emit('telemetry-pulse', {
      currentNorm: Math.min(1, loadPulseMa.value / 2500),
      socNorm: selectedProfile.value.socPct / 100,
      tempNorm: Math.max(0, (selectedProfile.value.tempC - 20) / 160)
    });
    nextTick(drawAllCharts);
  },
  { deep: true }
);

function selectProfile(id) {
  customLiveSamples.value = null;
  hardwareSourceLabel.value = 'Electrochemical Cell Simulator';
  selectedProfileId.value = id;
}

async function triggerHardwareLoadTest() {
  pulseRunning.value = true;
  pulseProgress.value = 0;
  const res = await runLiveBrowserLoadPulse((pct) => {
    pulseProgress.value = pct;
  });
  customLiveSamples.value = {
    timesS: res.timesS,
    voltagesMv: res.voltagesMv,
    currentsMa: res.currentsMa,
    uOcvMv: res.uOcvMv
  };
  hardwareSourceLabel.value = res.hardwareSource;
  pulseRunning.value = false;
  nextTick(drawAllCharts);
}

async function saveToVault() {
  await saveDiagnosticRecord('thevenin_dcir_tests', {
    profile: selectedProfile.value.label,
    source: hardwareSourceLabel.value,
    r0Mohm: analysis.value.thevenin.r0Mohm,
    totalDcirMohm: analysis.value.totalDcirMohm,
    sohPct: analysis.value.icaMetrics.estimatedSohPct,
    lliPct: analysis.value.icaMetrics.lliPct,
    lamPct: analysis.value.icaMetrics.lamPct,
    pMaxWatts: analysis.value.pMaxWatts
  });
  savedNotice.value = 'Saved to IndexedDB Vault & Sync Queue';
  emit('record-saved');
  setTimeout(() => (savedNotice.value = ''), 3200);
}

function setupCanvas(canvas) {
  if (!canvas) return null;
  const rect = canvas.getBoundingClientRect();
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = Math.max(300, Math.round(rect.width || 480));
  const h = Math.max(200, Math.round(rect.height || 250));
  if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
    canvas.width = w * dpr;
    canvas.height = h * dpr;
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}

function drawTransientChart() {
  const setup = setupCanvas(transientCanvas.value);
  if (!setup) return;
  const { ctx, w, h } = setup;
  const { timesS, voltagesMv, currentsMa } = analysis.value.transient;
  const pad = { l: 50, r: 44, t: 22, b: 30 };
  const pw = w - pad.l - pad.r;
  const ph = h - pad.t - pad.b;

  const minV = Math.min(...voltagesMv) - 45;
  const maxV = Math.max(...voltagesMv) + 35;
  const maxT = Math.max(...timesS, 1);

  // Grid
  ctx.strokeStyle = 'rgba(148,163,184,0.16)';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = pad.t + (ph * i) / 4;
    ctx.beginPath();
    ctx.moveTo(pad.l, y);
    ctx.lineTo(w - pad.r, y);
    ctx.stroke();
    const vLbl = Math.round(maxV - ((maxV - minV) * i) / 4);
    ctx.fillStyle = '#94a3b8';
    ctx.font = '10px JetBrains Mono, monospace';
    ctx.fillText(`${vLbl}`, 6, y + 3);
  }

  // Current pulse fill
  const maxI = Math.max(...currentsMa, 500);
  ctx.beginPath();
  timesS.forEach((t, idx) => {
    const x = pad.l + (t / maxT) * pw;
    const y = pad.t + ph - (currentsMa[idx] / (maxI * 1.35)) * ph;
    if (idx === 0) ctx.moveTo(x, pad.t + ph);
    ctx.lineTo(x, y);
  });
  ctx.lineTo(pad.l + pw, pad.t + ph);
  ctx.closePath();
  ctx.fillStyle = 'rgba(16, 185, 129, 0.14)';
  ctx.fill();

  // Voltage curve
  ctx.beginPath();
  timesS.forEach((t, idx) => {
    const x = pad.l + (t / maxT) * pw;
    const y = pad.t + ((maxV - voltagesMv[idx]) / Math.max(1, maxV - minV)) * ph;
    if (idx === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.strokeStyle = '#38bdf8';
  ctx.lineWidth = 2.4;
  ctx.stroke();

  // 3.0V UVLO Cutoff Threshold line
  if (minV <= 3050 && maxV >= 2950) {
    const yCut = pad.t + ((maxV - 3000) / Math.max(1, maxV - minV)) * ph;
    ctx.strokeStyle = '#f43f5e';
    ctx.setLineDash([5, 4]);
    ctx.beginPath();
    ctx.moveTo(pad.l, yCut);
    ctx.lineTo(w - pad.r, yCut);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#fda4af';
    ctx.fillText('UVLO 3000 mV', pad.l + 8, yCut - 5);
  }

  ctx.fillStyle = '#94a3b8';
  ctx.font = '10px JetBrains Mono, monospace';
  ctx.fillText('Terminal Voltage V_T (mV) vs. Load Step I (mA)', pad.l, 14);
  ctx.fillText('Time (s)', w - 58, h - 8);
}

function drawNyquistChart() {
  const setup = setupCanvas(nyquistCanvas.value);
  if (!setup) return;
  const { ctx, w, h } = setup;
  const pts = analysis.value.nyquist;
  const pad = { l: 46, r: 20, t: 24, b: 32 };
  const pw = w - pad.l - pad.r;
  const ph = h - pad.t - pad.b;

  const minRe = Math.max(0, Math.min(...pts.map((p) => p.zRealMohm)) - 10);
  const maxRe = Math.max(...pts.map((p) => p.zRealMohm)) + 15;
  const maxIm = Math.max(40, ...pts.map((p) => p.zNegImagMohm)) + 12;

  ctx.strokeStyle = 'rgba(148,163,184,0.16)';
  for (let i = 0; i <= 4; i++) {
    const y = pad.t + (ph * i) / 4;
    ctx.beginPath();
    ctx.moveTo(pad.l, y);
    ctx.lineTo(w - pad.r, y);
    ctx.stroke();
    ctx.fillStyle = '#94a3b8';
    ctx.font = '10px JetBrains Mono, monospace';
    ctx.fillText(`${Math.round(maxIm - (maxIm * i) / 4)}`, 8, y + 3);
  }

  ctx.beginPath();
  pts.forEach((p, idx) => {
    const x = pad.l + ((p.zRealMohm - minRe) / Math.max(1, maxRe - minRe)) * pw;
    const y = pad.t + ph - (p.zNegImagMohm / Math.max(1, maxIm)) * ph;
    if (idx === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.strokeStyle = '#a855f7';
  ctx.lineWidth = 2.4;
  ctx.stroke();

  pts.forEach((p, idx) => {
    const x = pad.l + ((p.zRealMohm - minRe) / Math.max(1, maxRe - minRe)) * pw;
    const y = pad.t + ph - (p.zNegImagMohm / Math.max(1, maxIm)) * ph;
    ctx.beginPath();
    ctx.arc(x, y, idx === 0 ? 4.5 : 3, 0, Math.PI * 2);
    ctx.fillStyle = idx === 0 ? '#10b981' : '#38bdf8';
    ctx.fill();
  });

  ctx.fillStyle = '#94a3b8';
  ctx.font = '10px JetBrains Mono, monospace';
  ctx.fillText('Nyquist EIS Cole-Cole: -Z_imag (mΩ) vs Z_real (mΩ)', pad.l, 14);
  ctx.fillText(`R0=${analysis.value.thevenin.r0Mohm} mΩ`, pad.l + 4, h - 9);
}

function drawIcaChart() {
  const setup = setupCanvas(icaCanvas.value);
  if (!setup) return;
  const { ctx, w, h } = setup;
  const { voltagesV, dqDvAhV, refDqDvAhV } = analysis.value.icaCurve;
  const pad = { l: 44, r: 18, t: 24, b: 30 };
  const pw = w - pad.l - pad.r;
  const ph = h - pad.t - pad.b;

  const maxY = Math.max(...refDqDvAhV, ...dqDvAhV) * 1.12;
  const minV = voltagesV[0];
  const maxV = voltagesV[voltagesV.length - 1];

  ctx.strokeStyle = 'rgba(148,163,184,0.16)';
  for (let i = 0; i <= 4; i++) {
    const y = pad.t + (ph * i) / 4;
    ctx.beginPath();
    ctx.moveTo(pad.l, y);
    ctx.lineTo(w - pad.r, y);
    ctx.stroke();
  }

  // Reference Fresh BOL curve (dashed)
  ctx.beginPath();
  voltagesV.forEach((v, idx) => {
    const x = pad.l + ((v - minV) / (maxV - minV)) * pw;
    const y = pad.t + ph - (refDqDvAhV[idx] / maxY) * ph;
    if (idx === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.strokeStyle = 'rgba(148, 163, 184, 0.55)';
  ctx.setLineDash([4, 4]);
  ctx.lineWidth = 1.6;
  ctx.stroke();
  ctx.setLineDash([]);

  // Measured / Simulated dQ/dV curve
  ctx.beginPath();
  voltagesV.forEach((v, idx) => {
    const x = pad.l + ((v - minV) / (maxV - minV)) * pw;
    const y = pad.t + ph - (dqDvAhV[idx] / maxY) * ph;
    if (idx === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.strokeStyle = '#10b981';
  ctx.lineWidth = 2.4;
  ctx.stroke();

  ctx.fillStyle = '#94a3b8';
  ctx.font = '10px JetBrains Mono, monospace';
  ctx.fillText('Incremental Capacity dQ/dV (Ah/V) · Graphite Staging Peaks', pad.l, 14);
  ctx.fillText('3.30V', pad.l, h - 8);
  ctx.fillText('4.25V', w - 42, h - 8);
}

function drawAllCharts() {
  drawTransientChart();
  drawNyquistChart();
  drawIcaChart();
}

onMounted(() => {
  nextTick(drawAllCharts);
  window.addEventListener('resize', drawAllCharts);
});
</script>

<template>
  <div class="lab-grid">
    <div class="glass-card panel-pad col-12">
      <div class="section-header">
        <div>
          <h2 class="section-title">
            <span>Module 1 · 2nd-Order Thevenin DCIR Pulse Analyzer &amp; dQ/dV Forensics</span>
            <span class="badge badge-emerald">Rust RLS Engine</span>
          </h2>
          <p class="section-subtitle">
            Measures Ohmic R0, Charge-Transfer R1/C1, Diffusion R2/C2, Maximum Power Capability, and Incremental Capacity LLI / LAM.
          </p>
        </div>
        <div style="display: flex; gap: 8px; flex-wrap: wrap;">
          <button class="pill-btn active" @click="triggerHardwareLoadTest" :disabled="pulseRunning">
            {{ pulseRunning ? `Running Pulse (${pulseProgress}%)` : 'Run Live Hardware Load Step' }}
          </button>
          <button class="pill-btn" @click="saveToVault">Save Audit to Vault</button>
        </div>
      </div>

      <div class="preset-strip">
        <button
          v-for="p in CELL_PROFILES"
          :key="p.id"
          class="pill-btn"
          :class="{ active: selectedProfileId === p.id && !customLiveSamples }"
          @click="selectProfile(p.id)"
        >
          {{ p.shortName }}
        </button>
      </div>

      <div style="display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 12px;">
        <div style="font-size: 0.78rem; color: var(--text-secondary);">
          <strong>Source:</strong> {{ hardwareSourceLabel }} · {{ selectedProfile.description }}
        </div>
        <span v-if="savedNotice" class="badge badge-emerald">{{ savedNotice }}</span>
      </div>

      <div class="slider-group" style="max-width: 420px;">
        <div class="slider-label">
          <span>Controlled Load Step Current (ΔI)</span>
          <span class="mono">{{ loadPulseMa }} mA</span>
        </div>
        <input type="range" min="400" max="3200" step="50" v-model.number="loadPulseMa" />
      </div>

      <div class="kpi-grid">
        <div class="kpi-tile">
          <div class="kpi-label">Ohmic Resistance (R0)</div>
          <div class="kpi-val" :style="{ color: analysis.thevenin.r0Mohm > 110 ? 'var(--accent-crimson)' : 'var(--accent-emerald)' }">
            {{ analysis.thevenin.r0Mohm }} mΩ
          </div>
          <div class="kpi-sub">Instantaneous &lt;10 ms SEI/tab drop</div>
        </div>
        <div class="kpi-tile">
          <div class="kpi-label">Effective DCIR (R_int)</div>
          <div class="kpi-val">{{ Math.round(dcirSpring.value.value * 10) / 10 }} mΩ</div>
          <div class="kpi-sub">P_max: {{ analysis.pMaxWatts }} W before 3.0V</div>
        </div>
        <div class="kpi-tile">
          <div class="kpi-label">True ICA Health (SOH)</div>
          <div class="kpi-val" style="color: var(--accent-cyan);">
            {{ Math.round(sohSpring.value.value * 10) / 10 }}%
          </div>
          <div class="kpi-sub">Remaining @ SOC: {{ analysis.trueRemainingMah }} mAh</div>
        </div>
        <div class="kpi-tile">
          <div class="kpi-label">UVLO Shutdown Risk</div>
          <div class="kpi-val" :style="{ color: analysis.uvloCriticalSoc > 20 ? 'var(--accent-crimson)' : 'var(--accent-emerald)' }">
            &lt; {{ analysis.uvloCriticalSoc }}% SOC
          </div>
          <div class="kpi-sub">Sudden 2.5A sag cutoff threshold</div>
        </div>
      </div>
    </div>

    <!-- Transient Voltage Sag Chart -->
    <div class="glass-card glass-interactive panel-pad col-6">
      <canvas ref="transientCanvas" class="chart-canvas"></canvas>
      <div style="margin-top: 8px; font-size: 0.75rem; color: var(--text-secondary); display: flex; justify-content: space-between;">
        <span>OCV Anchor: <strong class="mono">{{ analysis.uOcvV }} V</strong></span>
        <span>RLS Fit RMSE: <strong class="mono">{{ analysis.thevenin.rmseMv }} mV</strong></span>
      </div>
    </div>

    <!-- Nyquist EIS Cole-Cole Plot (Pro / Admin unlocked or previewed) -->
    <div class="glass-card glass-interactive panel-pad col-6">
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
        <span class="badge badge-violet">2RC ECM + Nyquist Cole-Cole (0.01 Hz – 10 kHz)</span>
        <span v-if="rbacRole === 'standard'" class="badge badge-amber">Standard View · Switch to Engineer for Matrix</span>
      </div>
      <canvas ref="nyquistCanvas" class="chart-canvas"></canvas>
      <div v-if="rbacRole !== 'standard'" class="mono" style="margin-top: 8px; font-size: 0.72rem; color: var(--text-secondary);">
        R1={{ analysis.thevenin.r1Mohm }} mΩ (C1={{ analysis.thevenin.c1Farads }} F) · R2={{ analysis.thevenin.r2Mohm }} mΩ (C2={{ analysis.thevenin.c2Farads }} F)
      </div>
    </div>

    <!-- Incremental Capacity Analysis dQ/dV -->
    <div class="glass-card glass-interactive panel-pad col-12">
      <div class="section-header" style="margin-bottom: 8px;">
        <div class="section-title" style="font-size: 0.94rem;">
          Incremental Capacity Analysis (dQ/dV) · Loss of Lithium Inventory (LLI) vs. Active Material (LAM)
        </div>
        <div style="display: flex; gap: 8px;">
          <span class="badge badge-amber">LLI: {{ analysis.icaMetrics.lliPct }}%</span>
          <span class="badge badge-crimson">LAM: {{ analysis.icaMetrics.lamPct }}%</span>
        </div>
      </div>
      <canvas ref="icaCanvas" class="chart-canvas"></canvas>
    </div>
  </div>
</template>
