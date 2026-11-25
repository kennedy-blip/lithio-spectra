import { ref, onUnmounted } from 'vue';

/**
 * Custom Hooke's Law second-order ODE spring physics composable:
 *   F = -k * (x - x_target) - c * v
 * Drives smooth overshoot-free or lightly underdamped electrochemical
 * gauge needles, Nyquist impedance sweeps, and tactile card interactions.
 */
export function useSpringPhysics(initialValue = 0, options = {}) {
  const stiffness = options.stiffness ?? 185;
  const damping = options.damping ?? 21;
  const mass = options.mass ?? 1.0;

  const value = ref(initialValue);
  const velocity = ref(0);
  const target = ref(initialValue);

  let rafId = null;
  let lastTs = 0;

  function step(ts) {
    if (!lastTs) lastTs = ts;
    const dt = Math.min(0.032, Math.max(0.001, (ts - lastTs) / 1000));
    lastTs = ts;

    const displacement = value.value - target.value;
    const accel = (-stiffness * displacement - damping * velocity.value) / mass;
    velocity.value += accel * dt;
    value.value += velocity.value * dt;

    if (Math.abs(displacement) < 0.0005 && Math.abs(velocity.value) < 0.001) {
      value.value = target.value;
      velocity.value = 0;
      rafId = null;
      lastTs = 0;
      return;
    }

    rafId = requestAnimationFrame(step);
  }

  function setTarget(nextTarget) {
    target.value = nextTarget;
    if (rafId === null) {
      lastTs = 0;
      rafId = requestAnimationFrame(step);
    }
  }

  function snap(nextValue) {
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    value.value = nextValue;
    target.value = nextValue;
    velocity.value = 0;
    lastTs = 0;
  }

  onUnmounted(() => {
    if (rafId !== null) cancelAnimationFrame(rafId);
  });

  return {
    value,
    target,
    velocity,
    setTarget,
    snap
  };
}
