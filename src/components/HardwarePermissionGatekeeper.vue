<script setup>
import { ref, onMounted } from 'vue';

const props = defineProps({
  sensorState: { type: Object, required: true }
});

const emit = defineEmits(['update-sensor']);

const expanded = ref(false);
const probing = ref(false);

async function probeBattery() {
  if (typeof navigator !== 'undefined' && typeof navigator.getBattery === 'function') {
    try {
      const b = await navigator.getBattery();
      emit('update-sensor', {
        key: 'battery',
        status: 'ACTIVE',
        detail: `${Math.round(b.level * 100)}% SOC · ${b.charging ? 'Charging' : 'Discharging'}`
      });
      return;
    } catch {
      // Fallback to simulator
    }
  }
  emit('update-sensor', {
    key: 'battery',
    status: 'SIMULATOR ACTIVE',
    detail: '20 Hz Native BatteryManager Bridge + Cell Presets'
  });
}

async function probeCamera() {
  if (typeof navigator !== 'undefined' && navigator.mediaDevices?.getUserMedia) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 60 } }
      });
      stream.getTracks().forEach((t) => t.stop());
      emit('update-sensor', {
        key: 'camera',
        status: 'ACTIVE',
        detail: '60 FPS Moire Optical Stream Ready'
      });
      return;
    } catch {
      // Denied or headless
    }
  }
  emit('update-sensor', {
    key: 'camera',
    status: 'SIMULATOR ACTIVE',
    detail: 'WebGL2 Synthetic Al-Laminate Plate Ready'
  });
}

async function probeMicrophone() {
  if (typeof navigator !== 'undefined' && navigator.mediaDevices?.getUserMedia) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
      });
      stream.getTracks().forEach((t) => t.stop());
      emit('update-sensor', {
        key: 'microphone',
        status: 'ACTIVE',
        detail: '48 kHz Unprocessed Ultrasonic Mic Ready'
      });
      return;
    } catch {
      // Denied or unavailable
    }
  }
  emit('update-sensor', {
    key: 'microphone',
    status: 'SIMULATOR ACTIVE',
    detail: '48 kHz Goertzel Flyback & Ping Synthesizer'
  });
}

async function probeMagnetometer() {
  if (typeof window !== 'undefined' && ('DeviceOrientationEvent' in window || 'Magnetometer' in window)) {
    emit('update-sensor', {
      key: 'magnetometer',
      status: 'ACTIVE',
      detail: '3-Axis IMU / Transformer Flux Bridge'
    });
  } else {
    emit('update-sensor', {
      key: 'magnetometer',
      status: 'SIMULATOR ACTIVE',
      detail: 'uT Leakage Flux Profile Model'
    });
  }
}

async function runFullProbe() {
  probing.value = true;
  await Promise.all([probeBattery(), probeCamera(), probeMicrophone(), probeMagnetometer()]);
  probing.value = false;
}

onMounted(() => {
  probeBattery();
});

function badgeClass(status) {
  if (status === 'ACTIVE') return 'badge-emerald';
  if (status === 'SIMULATOR ACTIVE') return 'badge-cyan';
  return 'badge-amber';
}
</script>

<template>
  <section class="glass-card panel-pad">
    <div class="section-header" style="margin-bottom: 6px;">
      <div>
        <div class="section-title" style="font-size: 0.9rem;">
          <span>Hardware &amp; OS Sensor Gatekeeper</span>
          <span class="badge badge-cyan">Capacitor 6 + Web APIs</span>
        </div>
        <div class="section-subtitle">
          Live telemetry bridge with deterministic built-in electrochemical simulators when hardware permissions are restricted.
        </div>
      </div>
      <div style="display: flex; gap: 8px; flex-wrap: wrap;">
        <button class="pill-btn" @click="runFullProbe" :disabled="probing">
          {{ probing ? 'Probing Sensors...' : 'Probe Hardware APIs' }}
        </button>
        <button class="pill-btn" @click="expanded = !expanded">
          {{ expanded ? 'Hide Matrix' : 'Sensor Details' }}
        </button>
      </div>
    </div>

    <div style="display: flex; flex-wrap: wrap; gap: 8px;">
      <span class="badge" :class="badgeClass(sensorState.battery.status)">
        BatteryManager: {{ sensorState.battery.status }}
      </span>
      <span class="badge" :class="badgeClass(sensorState.camera.status)">
        60 FPS Camera + Torch: {{ sensorState.camera.status }}
      </span>
      <span class="badge" :class="badgeClass(sensorState.microphone.status)">
        48 kHz Unprocessed Mic: {{ sensorState.microphone.status }}
      </span>
      <span class="badge" :class="badgeClass(sensorState.magnetometer.status)">
        3-Axis Magnetometer / IMU: {{ sensorState.magnetometer.status }}
      </span>
    </div>

    <div v-if="expanded" style="margin-top: 12px; display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 10px;">
      <div v-for="(item, key) in sensorState" :key="key" class="kpi-tile">
        <div class="kpi-label">{{ item.label }}</div>
        <div style="font-size: 0.8rem; font-weight: 600;">{{ item.detail }}</div>
        <div class="kpi-sub">{{ item.nativePlugin }}</div>
      </div>
    </div>
  </section>
</template>
