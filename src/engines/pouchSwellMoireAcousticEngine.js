/**
 * Optical Moire Fringe Profilometry, Timoshenko Clamped-Plate Gas Pressure (kPa),
 * and Acoustic Impulse Ping Porosity & Stiffness Assay Engine.
 */

const R_GAS = 8.314462618;

export const POUCH_SWELL_PRESETS = [
  {
    id: 'flat-healthy',
    label: 'Flat Healthy Prismatic / Pouch Cell',
    shortName: 'Healthy Flat (0.04 mm)',
    bulgeMm: 0.04,
    lengthMm: 92,
    widthMm: 64,
    wallThicknessMm: 0.42,
    centroidHz: 4620,
    dampingZeta: 0.042,
    notes: 'Taut laminated separator stack; crisp high-Q mechanical ping resonance.'
  },
  {
    id: 'early-subchassis',
    label: 'Early Sub-Chassis Gas Swelling (Trackpad Lift)',
    shortName: 'Early Swell (0.65 mm)',
    bulgeMm: 0.65,
    lengthMm: 95,
    widthMm: 66,
    wallThicknessMm: 0.42,
    centroidHz: 3180,
    dampingZeta: 0.118,
    notes: 'CO2/C2H4 electrolyte oxidation gas beginning to bow trackpad or back glass.'
  },
  {
    id: 'spicy-pillow-critical',
    label: 'Severe "Spicy Pillow" Delaminated Pouch',
    shortName: 'Spicy Pillow (3.40 mm)',
    bulgeMm: 3.40,
    lengthMm: 98,
    widthMm: 68,
    wallThicknessMm: 0.42,
    centroidHz: 1420,
    dampingZeta: 0.295,
    notes: 'CRITICAL: High internal gas pressure & electrode delamination; puncture/fire risk!'
  },
  {
    id: 'over-lithiated-rigid',
    label: 'Over-Lithiated Rigid Anode Expansion',
    shortName: 'Rigid Plating (0.38 mm)',
    bulgeMm: 0.38,
    lengthMm: 92,
    widthMm: 64,
    wallThicknessMm: 0.48,
    centroidHz: 5280,
    dampingZeta: 0.031,
    notes: 'Elevated resonant centroid frequency indicates stiff graphite plating rather than soft gas.'
  }
];

/**
 * Solves Timoshenko's Clamped Rectangular Plate Deflection Theory for internal gas gauge pressure:
 *   w_max = alpha * P * b^4 / D,  D = E * h^3 / (12 * (1 - nu^2))
 */
export function solveTimoshenkoGasPressure({
  bulgeMm,
  lengthMm = 94,
  widthMm = 65,
  wallThicknessMm = 0.42,
  tempC = 27.0
}) {
  const a = Math.max(20, lengthMm) / 1000;
  const b = Math.max(20, Math.min(lengthMm, widthMm)) / 1000;
  const h = Math.max(0.12, wallThicknessMm) / 1000;
  const wMax = Math.max(0, bulgeMm) / 1000;

  // Composite Al-laminate + display/chassis effective Young's modulus (~38 GPa)
  const E = 3.8e10;
  const nu = 0.33;
  const D = (E * Math.pow(h, 3)) / (12 * (1 - nu * nu));

  // Timoshenko clamped plate coefficient alpha for aspect ratio a/b (~1.45 -> ~0.0021)
  const ratio = a / b;
  const alpha = 0.00126 + 0.00095 * Math.min(1.0, (ratio - 1.0) / 1.0);

  const pressurePaBending = (wMax * D) / (alpha * Math.pow(b, 4));
  // Foppl-von Karman large-deflection membrane stiffening when wMax > h
  const membraneFactor = 1 + 0.14 * Math.pow(wMax / h, 1.65);
  const pressurePa = pressurePaBending * membraneFactor;
  const pressureKpa = Math.round((pressurePa / 1000) * 10) / 10;

  // Volume of domed cosine bulge: V ≈ 0.25 * a * b * w_max
  const bulgeVolM3 = 0.25 * a * b * wMax;
  const bulgeVolMl = Math.round(bulgeVolM3 * 1e6 * 100) / 100;

  // Ideal gas law millimoles of decomposed CO2 / CO / C2H4
  const absPressurePa = 101325 + pressurePa;
  const molesGas = (absPressurePa * bulgeVolM3) / (R_GAS * (tempC + 273.15));
  const mmolGas = Math.round(molesGas * 1000 * 100) / 100;

  let hazardTier = 'NOMINAL';
  if (bulgeMm >= 1.8 || pressureKpa >= 95) hazardTier = 'CRITICAL_FIRE_HAZARD';
  else if (bulgeMm >= 0.45 || pressureKpa >= 22) hazardTier = 'ELEVATED_OUTGASSING';

  return {
    pressureKpa,
    bulgeVolMl,
    mmolGas,
    flexuralRigidityNm: Math.round(D * 1000) / 1000,
    hazardTier
  };
}

/**
 * Analyzes an acoustic tap/ping waveform (either live PCM buffer or preset signature)
 * to extract resonant centroid frequency (Hz), damping ratio zeta, and bulk modulus proxy.
 */
export function analyzeAcousticPingResponse(presetOrBuffer, sampleRate = 48000) {
  if (Array.isArray(presetOrBuffer) || ArrayBuffer.isView(presetOrBuffer)) {
    const buf = presetOrBuffer;
    const n = Math.min(buf.length, 4096);
    if (n < 64) return analyzeAcousticPingResponse(POUCH_SWELL_PRESETS[0]);

    // Zero-crossing + Goertzel spectral centroid over 500 Hz - 12 kHz
    let weightedSum = 0;
    let totalPow = 0;
    const spectrum = [];
    for (let f = 600; f <= 10000; f += 250) {
      const w = (2 * Math.PI * f) / sampleRate;
      const coeff = 2 * Math.cos(w);
      let q1 = 0;
      let q2 = 0;
      for (let i = 0; i < n; i++) {
        const q0 = coeff * q1 - q2 + buf[i];
        q2 = q1;
        q1 = q0;
      }
      const p = Math.max(1e-9, q1 * q1 + q2 * q2 - q1 * q2 * coeff);
      const db = Math.max(-70, 10 * Math.log10(p / n));
      spectrum.push({ freqHz: f, magDb: Math.round(db * 10) / 10 });
      weightedSum += f * p;
      totalPow += p;
    }

    const centroidHz = totalPow > 0 ? Math.round(weightedSum / totalPow) : 3400;
    // Estimate decay ratio from first half vs second half RMS
    let e1 = 0;
    let e2 = 0;
    const half = Math.floor(n / 2);
    for (let i = 0; i < half; i++) e1 += buf[i] * buf[i];
    for (let i = half; i < n; i++) e2 += buf[i] * buf[i];
    const ratio = Math.sqrt(Math.max(1e-6, e2) / Math.max(1e-6, e1));
    const dampingZeta = Math.min(0.45, Math.max(0.02, -Math.log(Math.min(0.95, ratio)) * 0.14));

    return {
      centroidHz,
      dampingZeta: Math.round(dampingZeta * 1000) / 1000,
      bulkModulusIndex: Math.round((centroidHz / 4600) * (0.05 / Math.max(0.025, dampingZeta)) * 100),
      gasVoidLikelihoodPct: Math.min(99, Math.max(3, Math.round((dampingZeta / 0.25) * 85))),
      spectrum
    };
  }

  // Synthesize realistic acoustic impulse spectrum from preset parameters
  const preset = presetOrBuffer;
  const spectrum = [];
  for (let f = 600; f <= 10000; f += 250) {
    const bw = preset.centroidHz * preset.dampingZeta * 2.4;
    const lorenz = 1 / (1 + Math.pow((f - preset.centroidHz) / Math.max(180, bw), 2));
    const harmonic = 0.28 / (1 + Math.pow((f - preset.centroidHz * 1.65) / 550, 2));
    const magDb = -52 + 44 * Math.min(1, lorenz + harmonic);
    spectrum.push({ freqHz: f, magDb: Math.round(magDb * 10) / 10 });
  }

  return {
    centroidHz: preset.centroidHz,
    dampingZeta: preset.dampingZeta,
    bulkModulusIndex: Math.round((preset.centroidHz / 4600) * (0.05 / preset.dampingZeta) * 100),
    gasVoidLikelihoodPct:
      preset.bulgeMm < 0.15
        ? 4
        : preset.id === 'over-lithiated-rigid'
          ? 18
          : Math.min(98, Math.round((preset.dampingZeta / 0.28) * 94)),
    spectrum
  };
}
