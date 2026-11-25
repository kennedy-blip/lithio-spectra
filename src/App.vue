<script setup>
import { ref, reactive, computed, watch, onMounted, onUnmounted, nextTick } from 'vue';
import bgShaderSrc from './shaders/lithiumIntercalationBackground.glsl?raw';

import HardwarePermissionGatekeeper from './components/HardwarePermissionGatekeeper.vue';
import TheveninDcirIcaForensicsLab from './components/TheveninDcirIcaForensicsLab.vue';
import PouchSwellMoireAcousticScanner from './components/PouchSwellMoireAcousticScanner.vue';
import SemenovThermalRunawayShield from './components/SemenovThermalRunawayShield.vue';
import ChargerFlybackAcousticAuditor from './components/ChargerFlybackAcousticAuditor.vue';
import SeiAgingEvValuationArchitect from './components/SeiAgingEvValuationArchitect.vue';
import PolyglotRuntimeInspectorModal from './components/PolyglotRuntimeInspectorModal.vue';
import ApkReleaseDownloadModal from './components/ApkReleaseDownloadModal.vue';

const tabs = [
  { id: 'dcir', label: '1. DCIR & dQ/dV', short: 'DCIR' },
  { id: 'swell', label: '2. Swell Moiré', short: 'Swell' },
  { id: 'thermal', label: '3. Semenov Fire', short: 'Thermal' },
  { id: 'charger', label: '4. Charger EMF', short: 'Charger' },
  { id: 'valuation', label: '5. SEI & EV Value', short: 'EV Value' }
];

const activeTab = ref('dcir');
const viewportMode = ref('desktop'); // 'desktop' | 'mobile'
const themeMode = ref('obsidian');   // 'obsidian' | 'daylight' | 'thermal' | 'eco'
const rbacRole = ref('engineer');    // 'standard' | 'engineer' | 'admin'

const showApkModal = ref(false);
const showPolyglotModal = ref(false);
const savedCount = ref(0);

const bgCanvas = ref(null);
const dockButtons = ref([]);
const blobStyle = ref({ left: '8px', width: '110px' });

const shaderState = reactive({
  currentNorm: 0.45,
  socNorm: 0.65,
  tempNorm: 0.12,
  pointerX: 0.5,
  pointerY: 0.5
});

const sensorState = reactive({
  battery: {
    label: 'OS BatteryManager',
    status: 'SIMULATOR ACTIVE',
    detail: '20 Hz Native BatteryManager Bridge + Cell Presets',
    nativePlugin: 'NativeBatteryTelemetryLoadPlugin.java'
  },
  camera: {
    label: '60 FPS Camera + Torch',
    status: 'SIMULATOR ACTIVE',
    detail: 'WebGL2 Synthetic Al-Laminate Plate Ready',
    nativePlugin: 'WebRTC 1080p60 + Camera2 Torch'
  },
  microphone: {
    label: '48 kHz Unprocessed Mic',
    status: 'SIMULATOR ACTIVE',
    detail: '48 kHz Goertzel Flyback & Ping Synthesizer',
    nativePlugin: 'UltrasonicChargerEmfPlugin.java'
  },
  magnetometer: {
    label: '3-Axis Magnetometer / IMU',
    status: 'SIMULATOR ACTIVE',
    detail: 'uT Leakage Flux Profile Model',
    nativePlugin: 'Sensor.TYPE_MAGNETIC_FIELD_UNCALIBRATED'
  }
});

function handleUpdateSensor({ key, status, detail }) {
  if (sensorState[key]) {
    sensorState[key].status = status;
    sensorState[key].detail = detail;
  }
}

function handleTelemetryPulse(payload) {
  if (typeof payload.currentNorm === 'number') shaderState.currentNorm = payload.currentNorm;
  if (typeof payload.socNorm === 'number') shaderState.socNorm = payload.socNorm;
  if (typeof payload.tempNorm === 'number') shaderState.tempNorm = payload.tempNorm;
}

function updateGooeyBlob() {
  const idx = tabs.findIndex((t) => t.id === activeTab.value);
  const el = dockButtons.value[idx];
  if (el) {
    blobStyle.value = {
      left: `${el.offsetLeft}px`,
      width: `${el.offsetWidth}px`
    };
  }
}

watch(activeTab, () => nextTick(updateGooeyBlob));
watch(themeMode, (val) => {
  document.body.setAttribute('data-theme', val);
});

const anyModalOpen = computed(() => showApkModal.value || showPolyglotModal.value);

function openInspector() {
  if (rbacRole.value !== 'admin') {
    rbacRole.value = 'admin';
  }
  showPolyglotModal.value = true;
}

// WebGL2 Li+ Intercalation Background Shader
let gl = null;
let program = null;
let rafId = null;

function initBackgroundShader() {
  const canvas = bgCanvas.value;
  if (!canvas) return;
  gl = canvas.getContext('webgl2', { alpha: false, antialias: false });
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
  const fs = compile(gl.FRAGMENT_SHADER, bgShaderSrc);
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

  let lastFrame = 0;
  const render = (now) => {
    rafId = requestAnimationFrame(render);
    if (themeMode.value === 'eco') {
      if (now - lastFrame < 250) return; // Low-GPU throttle so baseline resting current stays clean
    }
    lastFrame = now;

    const scale = themeMode.value === 'eco' ? 0.35 : 0.75;
    const w = Math.max(320, Math.round(window.innerWidth * scale));
    const h = Math.max(240, Math.round(window.innerHeight * scale));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }

    gl.viewport(0, 0, w, h);
    gl.useProgram(program);

    const tMap = { obsidian: 0, daylight: 1, thermal: 2, eco: 3 };
    gl.uniform2f(gl.getUniformLocation(program, 'u_resolution'), w, h);
    gl.uniform1f(gl.getUniformLocation(program, 'u_time'), now * 0.001);
    gl.uniform1f(gl.getUniformLocation(program, 'u_current_norm'), shaderState.currentNorm);
    gl.uniform1f(gl.getUniformLocation(program, 'u_soc_norm'), shaderState.socNorm);
    gl.uniform1f(gl.getUniformLocation(program, 'u_temp_norm'), shaderState.tempNorm);
    gl.uniform1f(gl.getUniformLocation(program, 'u_theme_mode'), tMap[themeMode.value] ?? 0);
    gl.uniform2f(gl.getUniformLocation(program, 'u_pointer'), shaderState.pointerX, shaderState.pointerY);

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  };

  rafId = requestAnimationFrame(render);
}

function handlePointerMove(e) {
  shaderState.pointerX = e.clientX / Math.max(1, window.innerWidth);
  shaderState.pointerY = 1.0 - e.clientY / Math.max(1, window.innerHeight);
}

onMounted(() => {
  document.body.setAttribute('data-theme', themeMode.value);
  initBackgroundShader();
  nextTick(updateGooeyBlob);
  window.addEventListener('resize', updateGooeyBlob);
  window.addEventListener('pointermove', handlePointerMove, { passive: true });
});

onUnmounted(() => {
  if (rafId) cancelAnimationFrame(rafId);
  window.removeEventListener('resize', updateGooeyBlob);
  window.removeEventListener('pointermove', handlePointerMove);
});
</script>

<template>
  <!-- Layer 0: WebGL2 Li+ Intercalation Underlay -->
  <canvas ref="bgCanvas" class="webgl-underlay"></canvas>

  <!-- Inline SVG feTurbulence Anode Graphite Micro-Grain + Gooey Dock Filter -->
  <svg class="graphite-grain-overlay" width="100%" height="100%">
    <defs>
      <filter id="lithio-graphite-noise">
        <feTurbulence type="fractalNoise" baseFrequency="0.82" numOctaves="3" stitchTiles="stitch" />
      </filter>
      <filter id="lithio-gooey-dock">
        <feGaussianBlur in="SourceGraphic" stdDeviation="6" result="blur" />
        <feColorMatrix
          in="blur"
          mode="matrix"
          values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 19 -9"
          result="goo"
        />
        <feComposite in="SourceGraphic" in2="goo" operator="atop" />
      </filter>
    </defs>
    <rect width="100%" height="100%" filter="url(#lithio-graphite-noise)" />
  </svg>

  <div class="app-shell" :class="{ 'modal-depth-pushed': anyModalOpen }">
    <!-- Top Glassmorphic Control Header -->
    <header class="glass-card glass-card-elevated top-bar">
      <div class="brand-cluster">
        <div class="brand-orb">Li+</div>
        <div>
          <div class="brand-title">
            <span>LITHIO-SPECTRA</span>
            <span class="badge badge-emerald">v1.24.0</span>
          </div>
          <div class="brand-sub">
            DCIR · Moiré Swell · Semenov Runaway · Charger Forensics · Used-EV Valuation
          </div>
        </div>
      </div>

      <div class="toolbar-controls">
        <!-- Viewport Switcher -->
        <button
          class="pill-btn"
          :class="{ active: viewportMode === 'desktop' }"
          @click="viewportMode = 'desktop'"
        >
          Desktop Workstation
        </button>
        <button
          class="pill-btn"
          :class="{ active: viewportMode === 'mobile' }"
          @click="viewportMode = 'mobile'"
        >
          Mobile APK Frame
        </button>

        <!-- Theme Switcher -->
        <select class="select-glass" v-model="themeMode" aria-label="Electrochemical Theme">
          <option value="obsidian">Theme: Gigafactory Obsidian</option>
          <option value="daylight">Theme: Cleanroom Daylight Frost</option>
          <option value="thermal">Theme: Semenov Thermal Alert</option>
          <option value="eco">Theme: Eco-Glass Low-GPU</option>
        </select>

        <!-- RBAC Switcher -->
        <select class="select-glass" v-model="rbacRole" aria-label="RBAC Privilege Tier">
          <option value="standard">Role: Owner / EV Buyer</option>
          <option value="engineer">Role: BMS Engineer (Pro)</option>
          <option value="admin">Role: ESS Architect (Admin)</option>
        </select>

        <!-- Polyglot Inspector -->
        <button class="pill-btn" @click="openInspector">
          Polyglot Inspector
          <span v-if="savedCount > 0" class="badge badge-cyan">{{ savedCount }}</span>
        </button>

        <!-- One-Tap APK Download Trigger -->
        <button class="pill-btn btn-primary-apk" @click="showApkModal = true">
          Download Android .APK v1.24.0
        </button>
      </div>
    </header>

    <!-- Main Workspace (Desktop or Mobile APK Frame Preview) -->
    <div :class="viewportMode === 'mobile' ? 'apk-frame-wrapper' : ''">
      <div :class="viewportMode === 'mobile' ? 'apk-device-bezel' : ''">
        <div v-if="viewportMode === 'mobile'" class="apk-notch">
          <span>20Hz BMS</span>
          <span>●</span>
          <span>48kHz</span>
        </div>

        <main class="workspace-main">
          <HardwarePermissionGatekeeper
            :sensor-state="sensorState"
            @update-sensor="handleUpdateSensor"
          />

          <TheveninDcirIcaForensicsLab
            v-if="activeTab === 'dcir'"
            :rbac-role="rbacRole"
            @telemetry-pulse="handleTelemetryPulse"
            @record-saved="savedCount++"
          />
          <PouchSwellMoireAcousticScanner
            v-else-if="activeTab === 'swell'"
            @record-saved="savedCount++"
          />
          <SemenovThermalRunawayShield
            v-else-if="activeTab === 'thermal'"
            @telemetry-pulse="handleTelemetryPulse"
            @record-saved="savedCount++"
          />
          <ChargerFlybackAcousticAuditor
            v-else-if="activeTab === 'charger'"
            @record-saved="savedCount++"
          />
          <SeiAgingEvValuationArchitect
            v-else-if="activeTab === 'valuation'"
            @record-saved="savedCount++"
          />
        </main>
      </div>
    </div>
  </div>

  <!-- Gooey Metaball Bottom Navigation Dock -->
  <nav class="gooey-dock-container" aria-label="Electrochemistry Lab Navigation">
    <div class="gooey-dock-shell">
      <div class="gooey-liquid-layer">
        <div class="gooey-blob" :style="blobStyle"></div>
      </div>
      <button
        v-for="(tab, idx) in tabs"
        :key="tab.id"
        :ref="(el) => (dockButtons[idx] = el)"
        class="dock-tab-btn"
        :class="{ active: activeTab === tab.id }"
        @click="activeTab = tab.id"
      >
        {{ viewportMode === 'mobile' ? tab.short : tab.label }}
      </button>
    </div>
  </nav>

  <!-- Layer 3 Modals -->
  <ApkReleaseDownloadModal v-if="showApkModal" @close="showApkModal = false" />
  <PolyglotRuntimeInspectorModal v-if="showPolyglotModal" @close="showPolyglotModal = false" />
</template>
