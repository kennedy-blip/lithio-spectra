<script setup>
import { ref, computed, watch, onMounted, nextTick } from 'vue';
import {
  VEHICLE_AND_DEVICE_PRESETS,
  evaluateSeiAndValuation
} from '../engines/seiAgingEvValuationEngine.js';
import { saveDiagnosticRecord } from '../db/lithioVaultDb.js';

const emit = defineEmits(['record-saved']);

const selectedPresetId = ref(VEHICLE_AND_DEVICE_PRESETS[1].id);
const chemistry = ref('NMC');
const ambientTempC = ref(33);
const socMinPct = ref(20);
const socMaxPct = ref(80);
const chargeCRate = ref(0.6);
const dailyCycles = ref(0.65);
const packCapacityKwh = ref(40);
const replacementCostUsd = ref(11200);
const vehicleAgeYears = ref(5.5);
const odometerMiles = ref(58000);
const reportedSohPct = ref(73.2);
const dcFastChargePct = ref(54);

const savedNotice = ref('');
const solverOrigin = ref('Local Go 1.22 Parity Engine');
const seiChartCanvas = ref(null);

function loadPreset(p) {
  selectedPresetId.value = p.id;
  chemistry.value = p.chemistry;
  ambientTempC.value = p.ambientTempC;
  packCapacityKwh.value = p.packCapacityKwh;
  replacementCostUsd.value = p.replacementCostUsd;
  vehicleAgeYears.value = p.vehicleAgeYears;
  odometerMiles.value = p.odometerMiles;
  reportedSohPct.value = p.reportedSohPct;
  dcFastChargePct.value = p.dcFastChargePct;
}

const inputPayload = computed(() => ({
  chemistry: chemistry.value,
  ambientTempC: ambientTempC.value,
  socMinPct: socMinPct.value,
  socMaxPct: Math.max(socMinPct.value + 10, socMaxPct.value),
  chargeCRate: chargeCRate.value,
  dailyCycles: dailyCycles.value,
  packCapacityKwh: packCapacityKwh.value,
  replacementCostUsd: replacementCostUsd.value,
  vehicleAgeYears: vehicleAgeYears.value,
  odometerMiles: odometerMiles.value,
  reportedSohPct: reportedSohPct.value,
  dcFastChargePct: dcFastChargePct.value
}));

const audit = computed(() => evaluateSeiAndValuation(inputPayload.value));

async function verifyWithGoServerless() {
  try {
    const res = await fetch('/api/electrochem_battery_solver', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ module: 'sei_valuation', valuationInput: inputPayload.value })
    });
    if (res.ok) {
      const data = await res.json();
      if (data.valuationResult) {
        solverOrigin.value = `Live Vercel ${data.engine}`;
        return;
      }
    }
  } catch {
    // Offline fallback
  }
  solverOrigin.value = 'Local Go 1.22 Parity Engine (Offline-Ready)';
}

function drawSeiChart() {
  const canvas = seiChartCanvas.value;
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

  const pts = audit.value.trajectory;
  const pad = { l: 46, r: 18, t: 24, b: 30 };
  const pw = w - pad.l - pad.r;
  const ph = h - pad.t - pad.b;

  const minSoh = 45;
  const maxSoh = 102;

  ctx.strokeStyle = 'rgba(148,163,184,0.16)';
  for (let i = 0; i <= 4; i++) {
    const y = pad.t + (ph * i) / 4;
    ctx.beginPath();
    ctx.moveTo(pad.l, y);
    ctx.lineTo(w - pad.r, y);
    ctx.stroke();
    const lbl = Math.round(maxSoh - ((maxSoh - minSoh) * i) / 4);
    ctx.fillStyle = '#94a3b8';
    ctx.font = '10px JetBrains Mono, monospace';
    ctx.fillText(`${lbl}%`, 8, y + 3);
  }

  // 70% Warranty Threshold
  const y70 = pad.t + ((maxSoh - 70) / (maxSoh - minSoh)) * ph;
  ctx.strokeStyle = 'rgba(244, 63, 94, 0.7)';
  ctx.setLineDash([5, 4]);
  ctx.beginPath();
  ctx.moveTo(pad.l, y70);
  ctx.lineTo(w - pad.r, y70);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = '#fda4af';
  ctx.fillText('70% End-of-Warranty / Knee Threshold', pad.l + 8, y70 - 5);

  const plotLine = (key, color) => {
    ctx.beginPath();
    pts.forEach((p, idx) => {
      const x = pad.l + (p.year / 8.0) * pw;
      const y = pad.t + ((maxSoh - p[key]) / (maxSoh - minSoh)) * ph;
      if (idx === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.5;
    ctx.stroke();
  };

  plotLine('sohBaselinePct', '#f43f5e');
  plotLine('sohHabitPct', '#10b981');

  // Plot inspected EV/device dot at vehicleAgeYears
  const clampedAge = Math.min(8.0, Math.max(0.1, vehicleAgeYears.value));
  const xInsp = pad.l + (clampedAge / 8.0) * pw;
  const yInsp = pad.t + ((maxSoh - reportedSohPct.value) / (maxSoh - minSoh)) * ph;
  ctx.beginPath();
  ctx.arc(xInsp, yInsp, 6, 0, Math.PI * 2);
  ctx.fillStyle = '#38bdf8';
  ctx.fill();
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.fillStyle = '#7dd3fc';
  ctx.fillText(`Inspected (${reportedSohPct.value}%)`, Math.min(w - 125, xInsp + 8), yInsp + 4);

  ctx.fillStyle = '#94a3b8';
  ctx.font = '10px JetBrains Mono, monospace';
  ctx.fillText('8-Year SEI Growth: Optimized Window (Emerald) vs. 0-100% Hot Fast-Charge (Crimson)', pad.l, 14);
  ctx.fillText('0 yr', pad.l, h - 8);
  ctx.fillText('4 yr', pad.l + pw * 0.5, h - 8);
  ctx.fillText('8 yr', w - 34, h - 8);
}

async function saveToVault() {
  await saveDiagnosticRecord('ev_device_valuations', {
    chemistry: chemistry.value,
    reportedSohPct: reportedSohPct.value,
    expectedFleetSohPct: audit.value.expectedFleetSohPct,
    fairPriceAdjustUsd: audit.value.fairPriceAdjustUsd,
    riskReserveUsd: audit.value.riskReserveUsd,
    verdict: audit.value.verdict
  });
  savedNotice.value = 'EV / Device Valuation Saved';
  emit('record-saved');
  setTimeout(() => (savedNotice.value = ''), 3200);
}

watch(audit, () => nextTick(drawSeiChart), { deep: true });
onMounted(() => {
  nextTick(drawSeiChart);
});
</script>

<template>
  <div class="lab-grid">
    <div class="glass-card panel-pad col-12">
      <div class="section-header">
        <div>
          <h2 class="section-title">
            <span>Module 5 · Arrhenius SEI Aging Optimizer &amp; Used-EV / Device Valuation Auditor</span>
            <span class="badge badge-cyan">Go 1.22 Solver</span>
          </h2>
          <p class="section-subtitle">
            Proves 20–80% lifespan gains and audits used EVs/devices against fleet degradation curves for fair-price negotiation.
          </p>
        </div>
        <div style="display: flex; gap: 8px; flex-wrap: wrap;">
          <button class="pill-btn" @click="verifyWithGoServerless">Query Go API</button>
          <button class="pill-btn" @click="saveToVault">Save Valuation</button>
        </div>
      </div>

      <div class="preset-strip">
        <button
          v-for="p in VEHICLE_AND_DEVICE_PRESETS"
          :key="p.id"
          class="pill-btn"
          :class="{ active: selectedPresetId === p.id }"
          @click="loadPreset(p)"
        >
          {{ p.name }}
        </button>
      </div>

      <div v-if="savedNotice" class="badge badge-emerald" style="margin-bottom: 10px;">{{ savedNotice }}</div>

      <div class="kpi-grid">
        <div class="kpi-tile">
          <div class="kpi-label">Expected Fleet SOH</div>
          <div class="kpi-val">{{ audit.expectedFleetSohPct }}%</div>
          <div class="kpi-sub">Delta: {{ audit.sohDeltaPct >= 0 ? '+' : '' }}{{ audit.sohDeltaPct }}% (P{{ audit.fleetPercentile }})</div>
        </div>
        <div class="kpi-tile">
          <div class="kpi-label">Fair Price Adjustment</div>
          <div class="kpi-val" :style="{ color: audit.fairPriceAdjustUsd < 0 ? 'var(--accent-crimson)' : 'var(--accent-emerald)' }">
            {{ audit.fairPriceAdjustUsd >= 0 ? '+' : '-' }}${{ Math.abs(audit.fairPriceAdjustUsd).toLocaleString() }}
          </div>
          <div class="kpi-sub">Pack Risk Reserve: ${{ audit.riskReserveUsd.toLocaleString() }}</div>
        </div>
        <div class="kpi-tile">
          <div class="kpi-label">20–80% Lifespan Multiplier</div>
          <div class="kpi-val" style="color: var(--accent-emerald);">{{ audit.lifespanMultiplier }}×</div>
          <div class="kpi-sub">Years to 70% SOH: {{ audit.remainingYearsTo70 }} yrs</div>
        </div>
        <div class="kpi-tile">
          <div class="kpi-label">Warranty Status</div>
          <div class="kpi-val" style="font-size: 0.96rem;" :style="{ color: audit.warrantyEligible ? 'var(--accent-amber)' : 'var(--text-primary)' }">
            {{ audit.warrantyEligible ? 'ELIGIBLE (<70%)' : 'STANDARD / OUT' }}
          </div>
          <div class="kpi-sub">{{ solverOrigin }}</div>
        </div>
      </div>
    </div>

    <div class="glass-card glass-interactive panel-pad col-7">
      <canvas ref="seiChartCanvas" class="chart-canvas chart-canvas-tall"></canvas>
      <div style="margin-top: 10px; font-size: 0.8rem; font-weight: 600; color: var(--accent-cyan);">
        Verdict: {{ audit.verdict }}
      </div>
    </div>

    <div class="glass-card panel-pad col-5">
      <div class="section-title" style="font-size: 0.92rem; margin-bottom: 10px;">
        Charging Habit &amp; Inspection Parameters
      </div>

      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 10px;">
        <div>
          <label class="kpi-label">Chemistry</label>
          <select class="select-glass" style="width: 100%;" v-model="chemistry">
            <option value="NMC">NMC</option>
            <option value="NCA">NCA</option>
            <option value="LFP">LFP (LiFePO4)</option>
            <option value="LCO">LCO (Phone/Laptop)</option>
          </select>
        </div>
        <div>
          <label class="kpi-label">Reported SOH (%)</label>
          <input type="number" step="0.5" min="35" max="100" v-model.number="reportedSohPct" />
        </div>
        <div>
          <label class="kpi-label">Age (Years)</label>
          <input type="number" step="0.2" min="0.2" max="15" v-model.number="vehicleAgeYears" />
        </div>
        <div>
          <label class="kpi-label">Odometer (Miles)</label>
          <input type="number" step="1000" min="0" max="300000" v-model.number="odometerMiles" />
        </div>
        <div>
          <label class="kpi-label">Pack Replacement ($)</label>
          <input type="number" step="100" min="50" max="35000" v-model.number="replacementCostUsd" />
        </div>
        <div>
          <label class="kpi-label">DC Fast-Charge (%)</label>
          <input type="number" step="5" min="0" max="100" v-model.number="dcFastChargePct" />
        </div>
      </div>

      <div class="slider-group">
        <div class="slider-label"><span>Upper Charge Cap (SOC_max)</span><span class="mono">{{ socMaxPct }}%</span></div>
        <input type="range" min="55" max="100" step="1" v-model.number="socMaxPct" />
      </div>
      <div class="slider-group">
        <div class="slider-label"><span>Lower Charge Floor (SOC_min)</span><span class="mono">{{ socMinPct }}%</span></div>
        <input type="range" min="5" max="50" step="1" v-model.number="socMinPct" />
      </div>
      <div class="slider-group">
        <div class="slider-label"><span>Avg Ambient Temp</span><span class="mono">{{ ambientTempC }} °C</span></div>
        <input type="range" min="0" max="45" step="1" v-model.number="ambientTempC" />
      </div>
    </div>
  </div>
</template>
