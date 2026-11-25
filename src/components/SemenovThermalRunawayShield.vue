<script setup>
import { ref, computed, watch, onMounted, nextTick } from 'vue';
import { ABUSE_SCENARIOS, runSemenovThermalAudit } from '../engines/semenovThermalRunawayEngine.js';
import { platingSafeChargeCRate } from '../engines/rustElectrochemBridge.js';
import { saveDiagnosticRecord } from '../db/lithioVaultDb.js';

const emit = defineEmits(['telemetry-pulse', 'record-saved']);

const chemistries = ['NMC811', 'NCA', 'LCO', 'LFP'];
const selectedChem = ref('NMC811');
const selectedScenarioId = ref(ABUSE_SCENARIOS[1].id);

const tInitC = ref(82);
const tAmbC = ref(32);
const cRate = ref(1.5);
const dcirMohm = ref(110);
const hConvWK = ref(0.14);
const rShortOhm = ref(0.45);
const coldChargeTempC = ref(-8);
const coldChargeSocPct = ref(65);
const savedNotice = ref('');

const semenovCanvas = ref(null);
const trajectoryCanvas = ref(null);
const platingCanvas = ref(null);

function selectScenario(sc) {
  selectedScenarioId.value = sc.id;
  tInitC.value = sc.tInitC;
  tAmbC.value = sc.tAmbC;
  cRate.value = sc.cRate;
  dcirMohm.value = sc.dcirMohm;
  hConvWK.value = sc.hConvWK;
  rShortOhm.value = sc.rShortOhm;
}

const audit = computed(() =>
  runSemenovThermalAudit({
    chemistryKey: selectedChem.value,
    tInitC: tInitC.value,
    tAmbC: tAmbC.value,
    cRate: cRate.value,
    dcirMohm: dcirMohm.value,
    hConvWK: hConvWK.value,
    rShortOhm: rShortOhm.value
  })
);

const safeChargeLimitC = computed(() =>
  platingSafeChargeCRate(coldChargeTempC.value, coldChargeSocPct.value)
);

watch(
  audit,
  (val) => {
    emit('telemetry-pulse', {
      currentNorm: Math.min(1, cRate.value / 3.0),
      socNorm: coldChargeSocPct.value / 100,
      tempNorm: Math.min(1, Math.max(0, (val.peakTempC - 25) / 220))
    });
    nextTick(drawAll);
  },
  { deep: true }
);

watch([coldChargeTempC, coldChargeSocPct], () => nextTick(drawPlatingChart));

function setupCanvas(canvas) {
  if (!canvas) return null;
  const rect = canvas.getBoundingClientRect();
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = Math.max(300, Math.round(rect.width || 450));
  const h = Math.max(200, Math.round(rect.height || 245));
  if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
    canvas.width = w * dpr;
    canvas.height = h * dpr;
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}

function drawSemenovChart() {
  const setup = setupCanvas(semenovCanvas.value);
  if (!setup) return;
  const { ctx, w, h } = setup;
  const pts = audit.value.semenovCurve;
  const pad = { l: 46, r: 18, t: 24, b: 30 };
  const pw = w - pad.l - pad.r;
  const ph = h - pad.t - pad.b;

  const maxQ = Math.max(60, ...pts.map((p) => Math.max(p.qGenWatts, p.qCoolWatts))) * 1.08;
  const minT = pts[0]?.tempC ?? 20;
  const maxT = pts[pts.length - 1]?.tempC ?? 260;

  ctx.strokeStyle = 'rgba(148,163,184,0.16)';
  for (let i = 0; i <= 4; i++) {
    const y = pad.t + (ph * i) / 4;
    ctx.beginPath();
    ctx.moveTo(pad.l, y);
    ctx.lineTo(w - pad.r, y);
    ctx.stroke();
    ctx.fillStyle = '#94a3b8';
    ctx.font = '10px JetBrains Mono, monospace';
    ctx.fillText(`${Math.round(maxQ - (maxQ * i) / 4)}W`, 4, y + 3);
  }

  // Newton Cooling Line
  ctx.beginPath();
  pts.forEach((p, idx) => {
    const x = pad.l + ((p.tempC - minT) / Math.max(1, maxT - minT)) * pw;
    const y = pad.t + ph - (p.qCoolWatts / maxQ) * ph;
    if (idx === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.strokeStyle = '#38bdf8';
  ctx.setLineDash([5, 4]);
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.setLineDash([]);

  // Exothermic Heat Generation S-Curve
  ctx.beginPath();
  pts.forEach((p, idx) => {
    const x = pad.l + ((p.tempC - minT) / Math.max(1, maxT - minT)) * pw;
    const y = pad.t + ph - (p.qGenWatts / maxQ) * ph;
    if (idx === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.strokeStyle = '#f43f5e';
  ctx.lineWidth = 2.5;
  ctx.stroke();

  // T_crit marker
  const xCrit = pad.l + ((audit.value.tCritC - minT) / Math.max(1, maxT - minT)) * pw;
  if (xCrit >= pad.l && xCrit <= w - pad.r) {
    ctx.strokeStyle = '#f59e0b';
    ctx.beginPath();
    ctx.moveTo(xCrit, pad.t);
    ctx.lineTo(xCrit, pad.t + ph);
    ctx.stroke();
    ctx.fillStyle = '#fcd34d';
    ctx.fillText(`T_crit ${audit.value.tCritC}°C`, Math.min(w - 92, xCrit + 4), pad.t + 14);
  }

  ctx.fillStyle = '#94a3b8';
  ctx.font = '10px JetBrains Mono, monospace';
  ctx.fillText('Semenov Criticality: Q_gen(T) vs. Newton Cooling hA(T - T_amb)', pad.l, 14);
  ctx.fillText(`${minT}°C`, pad.l, h - 8);
  ctx.fillText(`${maxT}°C`, w - 42, h - 8);
}

function drawTrajectoryChart() {
  const setup = setupCanvas(trajectoryCanvas.value);
  if (!setup) return;
  const { ctx, w, h } = setup;
  const traj = audit.value.trajectory;
  const pad = { l: 46, r: 18, t: 24, b: 30 };
  const pw = w - pad.l - pad.r;
  const ph = h - pad.t - pad.b;

  const maxT = Math.max(180, ...traj.map((s) => s.tempC)) * 1.06;
  const maxTime = Math.max(60, traj[traj.length - 1]?.timeS || 600);

  ctx.strokeStyle = 'rgba(148,163,184,0.16)';
  for (let i = 0; i <= 4; i++) {
    const y = pad.t + (ph * i) / 4;
    ctx.beginPath();
    ctx.moveTo(pad.l, y);
    ctx.lineTo(w - pad.r, y);
    ctx.stroke();
    ctx.fillStyle = '#94a3b8';
    ctx.font = '10px JetBrains Mono, monospace';
    ctx.fillText(`${Math.round(maxT - (maxT * i) / 4)}°`, 6, y + 3);
  }

  // Separator Melt line
  const yMelt = pad.t + ph - (audit.value.kinetics.separatorMeltC / maxT) * ph;
  ctx.strokeStyle = 'rgba(245, 158, 11, 0.7)';
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(pad.l, yMelt);
  ctx.lineTo(w - pad.r, yMelt);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = '#fcd34d';
  ctx.fillText(`Separator Melt (${audit.value.kinetics.separatorMeltC}°C)`, pad.l + 6, yMelt - 4);

  ctx.beginPath();
  traj.forEach((s, idx) => {
    const x = pad.l + (s.timeS / maxTime) * pw;
    const y = pad.t + ph - (s.tempC / maxT) * ph;
    if (idx === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.strokeStyle = audit.value.runawayTimeS !== null ? '#f43f5e' : '#10b981';
  ctx.lineWidth = 2.6;
  ctx.stroke();

  ctx.fillStyle = '#94a3b8';
  ctx.font = '10px JetBrains Mono, monospace';
  ctx.fillText('RK4 4-Stage Arrhenius Temperature Trajectory T(t)', pad.l, 14);
  ctx.fillText(`0s`, pad.l, h - 8);
  ctx.fillText(`${Math.round(maxTime)}s`, w - 45, h - 8);
}

function drawPlatingChart() {
  const setup = setupCanvas(platingCanvas.value);
  if (!setup) return;
  const { ctx, w, h } = setup;
  const pts = audit.value.platingCurve;
  const pad = { l: 42, r: 16, t: 24, b: 28 };
  const pw = w - pad.l - pad.r;
  const ph = h - pad.t - pad.b;

  const maxC = 3.2;
  ctx.strokeStyle = 'rgba(148,163,184,0.16)';
  for (let i = 0; i <= 4; i++) {
    const y = pad.t + (ph * i) / 4;
    ctx.beginPath();
    ctx.moveTo(pad.l, y);
    ctx.lineTo(w - pad.r, y);
    ctx.stroke();
  }

  const drawCurve = (key, color) => {
    ctx.beginPath();
    pts.forEach((p, idx) => {
      const x = pad.l + (idx / Math.max(1, pts.length - 1)) * pw;
      const y = pad.t + ph - (p[key] / maxC) * ph;
      if (idx === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.2;
    ctx.stroke();
  };

  drawCurve('maxCAt50Soc', '#10b981');
  drawCurve('maxCAt80Soc', '#f59e0b');

  // Current operating point marker
  const xPt = pad.l + ((coldChargeTempC.value + 20) / 65) * pw;
  const yPt = pad.t + ph - (safeChargeLimitC.value / maxC) * ph;
  ctx.beginPath();
  ctx.arc(xPt, yPt, 5, 0, Math.PI * 2);
  ctx.fillStyle = coldChargeTempC.value <= 0 ? '#f43f5e' : '#38bdf8';
  ctx.fill();

  ctx.fillStyle = '#94a3b8';
  ctx.font = '10px JetBrains Mono, monospace';
  ctx.fillText('Non-Plating Safe Charge Limit C_max(T, SOC)', pad.l, 14);
  ctx.fillText('-20°C', pad.l, h - 8);
  ctx.fillText('+45°C', w - 42, h - 8);
}

function drawAll() {
  drawSemenovChart();
  drawTrajectoryChart();
  drawPlatingChart();
}

async function saveToVault() {
  await saveDiagnosticRecord('thermal_runaway_audits', {
    chemistry: selectedChem.value,
    tCritC: audit.value.tCritC,
    peakTempC: audit.value.peakTempC,
    runawayTimeS: audit.value.runawayTimeS,
    safeChargeLimitC: safeChargeLimitC.value
  });
  savedNotice.value = 'Thermal Safety Audit Saved';
  emit('record-saved');
  setTimeout(() => (savedNotice.value = ''), 3200);
}

onMounted(() => {
  nextTick(drawAll);
});
</script>

<template>
  <div class="lab-grid">
    <div class="glass-card panel-pad col-12">
      <div class="section-header">
        <div>
          <h2 class="section-title">
            <span>Module 3 · Semenov/Arrhenius 4-Stage Thermal Runaway &amp; Li-Plating Shield</span>
            <span class="badge badge-crimson">Rust RK4 Kinetics</span>
          </h2>
          <p class="section-subtitle">
            Bernardi Joule/Entropic heating + SEI/Anode/Separator/Cathode O2 decomposition + sub-zero dendrite plating limit.
          </p>
        </div>
        <div style="display: flex; gap: 8px; flex-wrap: wrap;">
          <button
            v-for="chem in chemistries"
            :key="chem"
            class="pill-btn"
            :class="{ active: selectedChem === chem }"
            @click="selectedChem = chem"
          >
            {{ chem }}
          </button>
          <button class="pill-btn" @click="saveToVault">Save Safety Audit</button>
        </div>
      </div>

      <div class="preset-strip">
        <button
          v-for="sc in ABUSE_SCENARIOS"
          :key="sc.id"
          class="pill-btn"
          :class="{ active: selectedScenarioId === sc.id }"
          @click="selectScenario(sc)"
        >
          {{ sc.label }}
        </button>
      </div>

      <div v-if="savedNotice" class="badge badge-emerald" style="margin-bottom: 10px;">{{ savedNotice }}</div>

      <div class="kpi-grid">
        <div class="kpi-tile">
          <div class="kpi-label">Semenov Critical Temp (T_crit)</div>
          <div class="kpi-val" style="color: var(--accent-amber);">{{ audit.tCritC }} °C</div>
          <div class="kpi-sub">Tangency where dQ_gen/dT ≥ hA</div>
        </div>
        <div class="kpi-tile">
          <div class="kpi-label">Time-to-Runaway</div>
          <div class="kpi-val" :style="{ color: audit.runawayTimeS !== null ? 'var(--accent-crimson)' : 'var(--accent-emerald)' }">
            {{ audit.runawayTimeS !== null ? `${audit.runawayTimeS} s` : 'ARRESTED / SAFE' }}
          </div>
          <div class="kpi-sub">
            Vent: {{ audit.ventTimeS !== null ? `${audit.ventTimeS}s` : 'N/A' }} · Melt: {{ audit.meltTimeS !== null ? `${audit.meltTimeS}s` : 'N/A' }}
          </div>
        </div>
        <div class="kpi-tile">
          <div class="kpi-label">Peak Core Temp / Rate</div>
          <div class="kpi-val">{{ audit.peakTempC }} °C</div>
          <div class="kpi-sub">Max dT/dt: {{ audit.peakRateCPerMin }} °C/min</div>
        </div>
        <div class="kpi-tile">
          <div class="kpi-label">Non-Plating Charge Limit</div>
          <div class="kpi-val" :style="{ color: safeChargeLimitC < 0.35 ? 'var(--accent-crimson)' : 'var(--accent-emerald)' }">
            {{ safeChargeLimitC }} C
          </div>
          <div class="kpi-sub">@ {{ coldChargeTempC }}°C, {{ coldChargeSocPct }}% SOC</div>
        </div>
      </div>
    </div>

    <div class="glass-card glass-interactive panel-pad col-6">
      <canvas ref="semenovCanvas" class="chart-canvas"></canvas>
      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 10px;">
        <div class="slider-group">
          <div class="slider-label"><span>Charge/Discharge Rate</span><span class="mono">{{ cRate }} C</span></div>
          <input type="range" min="0" max="4.0" step="0.1" v-model.number="cRate" />
        </div>
        <div class="slider-group">
          <div class="slider-label"><span>Convective Cooling (hA)</span><span class="mono">{{ hConvWK }} W/K</span></div>
          <input type="range" min="0.08" max="1.2" step="0.02" v-model.number="hConvWK" />
        </div>
      </div>
    </div>

    <div class="glass-card glass-interactive panel-pad col-6">
      <canvas ref="trajectoryCanvas" class="chart-canvas"></canvas>
      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 10px;">
        <div class="slider-group">
          <div class="slider-label"><span>Initial Core Temp</span><span class="mono">{{ tInitC }} °C</span></div>
          <input type="range" min="15" max="155" step="1" v-model.number="tInitC" />
        </div>
        <div class="slider-group">
          <div class="slider-label"><span>Micro-Short R_short (0 = None)</span><span class="mono">{{ rShortOhm }} Ω</span></div>
          <input type="range" min="0" max="3.0" step="0.1" v-model.number="rShortOhm" />
        </div>
      </div>
    </div>

    <div class="glass-card glass-interactive panel-pad col-12">
      <div style="display: grid; grid-template-columns: 2fr 1fr; gap: 16px; align-items: center;">
        <canvas ref="platingCanvas" class="chart-canvas" style="height: 200px;"></canvas>
        <div>
          <span class="badge badge-cyan" style="margin-bottom: 8px;">Sub-Zero Lithium Dendrite Guard</span>
          <div class="slider-group">
            <div class="slider-label"><span>Ambient / Cell Temp</span><span class="mono">{{ coldChargeTempC }} °C</span></div>
            <input type="range" min="-20" max="45" step="1" v-model.number="coldChargeTempC" />
          </div>
          <div class="slider-group">
            <div class="slider-label"><span>Current Pack SOC</span><span class="mono">{{ coldChargeSocPct }} %</span></div>
            <input type="range" min="10" max="95" step="1" v-model.number="coldChargeSocPct" />
          </div>
          <p style="font-size: 0.74rem; color: var(--text-secondary); margin: 0;">
            Charging faster than <strong class="mono">{{ safeChargeLimitC }} C</strong> at {{ coldChargeTempC }}°C forces anode potential &lt; 0V vs Li/Li+, plating metallic dendrites.
          </p>
        </div>
      </div>
    </div>
  </div>
</template>
