/**
 * Deterministic JS / WASM Bridge for rust-electrochem crate:
 * Mirrors:
 *  - rust-electrochem/src/thevenin_dcir_ica.rs
 *  - rust-electrochem/src/semenov_arrhenius_runaway.rs
 * Ensures 100% Vercel build & browser runtime parity even when cargo/wasm-pack is absent.
 */

const R_GAS = 8.314462618;

export function ocvFromSocNmcGraphite(socPct) {
  const s = Math.min(0.995, Math.max(0.005, socPct / 100));
  return (
    3.42 +
    0.78 * s -
    0.19 * Math.pow(1 - s, 3) +
    0.085 * Math.sin(6.2 * s) * 0.25 +
    0.14 * Math.tanh(s - 0.5)
  );
}

/**
 * 2nd-Order Thevenin (2RC) Recursive Least Squares (RLS) Identifier
 */
export function identifyThevenin2RcRls(timesS, voltagesMv, currentsMa, socPct = 65) {
  const t0 = performance.now();
  const n = Math.min(timesS.length, voltagesMv.length, currentsMa.length);
  if (n < 6) {
    return {
      r0Mohm: 45,
      r1Mohm: 22,
      c1Farads: 120,
      r2Mohm: 18,
      c2Farads: 1650,
      tau1S: 2.64,
      tau2S: 29.7,
      rmseMv: 0,
      execMs: performance.now() - t0
    };
  }

  // Estimate OCV from resting samples + anchor instantaneous R0 on sharpest dI step
  const uOcvMv = voltagesMv[0] + (Math.abs(currentsMa[0]) / 1000) * 50;
  let r0AnchorOhm = 0.055;
  let maxStepDi = 0;
  for (let k = 1; k < n; k++) {
    const di = Math.abs(currentsMa[k] - currentsMa[k - 1]);
    const dv = Math.abs(voltagesMv[k] - voltagesMv[k - 1]);
    if (di > 250 && di > maxStepDi) {
      maxStepDi = di;
      r0AnchorOhm = Math.min(1.2, Math.max(0.005, dv / di));
    }
  }

  const tau1 = 2.4;
  const tau2 = 28.0;
  const lambda = 0.985;

  const theta = [r0AnchorOhm, r0AnchorOhm * 0.42, r0AnchorOhm * 0.28];
  let P = [
    [0.02, 0.0, 0.0],
    [0.0, 4.0, 0.0],
    [0.0, 0.0, 4.0]
  ];

  let iPol1 = 0;
  let iPol2 = 0;

  for (let k = 1; k < n; k++) {
    const dt = Math.min(5.0, Math.max(0.01, timesS[k] - timesS[k - 1]));
    const iAmps = Math.abs(currentsMa[k]) / 1000;
    const e1 = Math.exp(-dt / tau1);
    const e2 = Math.exp(-dt / tau2);
    iPol1 = iPol1 * e1 + iAmps * (1 - e1);
    iPol2 = iPol2 * e2 + iAmps * (1 - e2);

    const phi = [iAmps, iPol1, iPol2];
    const yV = Math.max(0, uOcvMv - voltagesMv[k]) / 1000;

    const pPhi = [
      P[0][0] * phi[0] + P[0][1] * phi[1] + P[0][2] * phi[2],
      P[1][0] * phi[0] + P[1][1] * phi[1] + P[1][2] * phi[2],
      P[2][0] * phi[0] + P[2][1] * phi[1] + P[2][2] * phi[2]
    ];
    const denom = lambda + phi[0] * pPhi[0] + phi[1] * pPhi[1] + phi[2] * pPhi[2];
    const kGain = [pPhi[0] / denom, pPhi[1] / denom, pPhi[2] / denom];
    const err = yV - (theta[0] * phi[0] + theta[1] * phi[1] + theta[2] * phi[2]);

    for (let r = 0; r < 3; r++) {
      theta[r] = Math.min(1.5, Math.max(0.002, theta[r] + kGain[r] * err));
    }

    const nextP = [
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0]
    ];
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) {
        const kPhiP = kGain[r] * (phi[0] * P[0][c] + phi[1] * P[1][c] + phi[2] * P[2][c]);
        nextP[r][c] = (P[r][c] - kPhiP) / lambda;
      }
    }
    P = nextP;
  }

  let sqErr = 0;
  let ip1 = 0;
  let ip2 = 0;
  for (let k = 1; k < n; k++) {
    const dt = Math.min(5.0, Math.max(0.01, timesS[k] - timesS[k - 1]));
    const iAmps = Math.abs(currentsMa[k]) / 1000;
    const e1 = Math.exp(-dt / tau1);
    const e2 = Math.exp(-dt / tau2);
    ip1 = ip1 * e1 + iAmps * (1 - e1);
    ip2 = ip2 * e2 + iAmps * (1 - e2);
    const vPredMv = uOcvMv - 1000 * (theta[0] * iAmps + theta[1] * ip1 + theta[2] * ip2);
    const diff = vPredMv - voltagesMv[k];
    sqErr += diff * diff;
  }

  return {
    r0Mohm: Math.round(theta[0] * 1000 * 100) / 100,
    r1Mohm: Math.round(theta[1] * 1000 * 100) / 100,
    c1Farads: Math.round((tau1 / Math.max(0.001, theta[1])) * 10) / 10,
    r2Mohm: Math.round(theta[2] * 1000 * 100) / 100,
    c2Farads: Math.round((tau2 / Math.max(0.001, theta[2])) * 10) / 10,
    tau1S: tau1,
    tau2S: tau2,
    rmseMv: Math.round(Math.sqrt(sqErr / Math.max(1, n - 1)) * 100) / 100,
    execMs: Math.round((performance.now() - t0) * 1000) / 1000
  };
}

export function computeNyquistColeCole(params, warburgSigmaMohm = 6.5) {
  const freqs = [10000, 4000, 1500, 500, 180, 60, 20, 8, 3, 1, 0.4, 0.15, 0.06, 0.025, 0.01];
  return freqs.map((f) => {
    const w = 2 * Math.PI * f;
    const wt1 = w * params.tau1S;
    const wt2 = w * params.tau2S;
    const z1Re = params.r1Mohm / (1 + wt1 * wt1);
    const z1Im = (-params.r1Mohm * wt1) / (1 + wt1 * wt1);
    const z2Re = params.r2Mohm / (1 + wt2 * wt2);
    const z2Im = (-params.r2Mohm * wt2) / (1 + wt2 * wt2);
    const wFactor = f < 2.0 ? warburgSigmaMohm / Math.max(0.08, Math.sqrt(w)) : 0;
    return {
      freqHz: f,
      zRealMohm: Math.round((params.r0Mohm + z1Re + z2Re + wFactor) * 100) / 100,
      zNegImagMohm: Math.round(-(z1Im + z2Im - wFactor) * 100) / 100
    };
  });
}

export function deconvolveDqDvPeaks(voltagesV, dqDvAhV, ratedCapAh) {
  const findBand = (vMin, vMax) => {
    let bestV = (vMin + vMax) * 0.5;
    let bestH = 0;
    for (let i = 0; i < voltagesV.length; i++) {
      if (voltagesV[i] >= vMin && voltagesV[i] <= vMax && dqDvAhV[i] > bestH) {
        bestH = dqDvAhV[i];
        bestV = voltagesV[i];
      }
    }
    return { v: bestV, h: bestH };
  };

  const p1 = findBand(3.40, 3.63);
  const p2 = findBand(3.64, 3.88);
  const p3 = findBand(3.89, 4.18);

  const refP2 = Math.max(0.1, ratedCapAh * 1.45);
  const refP3 = Math.max(0.1, ratedCapAh * 0.92);

  const lliPct = Math.min(48, Math.max(0, (1 - Math.min(1.05, p3.h / refP3)) * 68));
  const lamPct = Math.min(45, Math.max(0, (1 - Math.min(1.05, p2.h / refP2)) * 55));
  const estimatedSohPct = Math.min(100, Math.max(45, 100 - 0.65 * lliPct - 0.55 * lamPct));

  return {
    peak1VoltageV: Math.round(p1.v * 1000) / 1000,
    peak1HeightAhV: Math.round(p1.h * 100) / 100,
    peak2VoltageV: Math.round(p2.v * 1000) / 1000,
    peak2HeightAhV: Math.round(p2.h * 100) / 100,
    peak3VoltageV: Math.round(p3.v * 1000) / 1000,
    peak3HeightAhV: Math.round(p3.h * 100) / 100,
    lliPct: Math.round(lliPct * 10) / 10,
    lamPct: Math.round(lamPct * 10) / 10,
    estimatedSohPct: Math.round(estimatedSohPct * 10) / 10
  };
}

export const CHEMISTRY_KINETICS = {
  NMC811: {
    name: 'NMC811',
    cellMassKg: 0.068,
    cpJKgK: 980,
    ratedAh: 5.0,
    dOcvDtVK: -0.00042,
    hSeiJKg: 2.57e5,
    aSeiS: 1.667e15,
    eaSeiJMol: 1.3508e5,
    hAnodeJKg: 1.714e6,
    aAnodeS: 2.5e13,
    eaAnodeJMol: 1.3508e5,
    hCathodeJKg: 5.10e5,
    aCathodeS: 6.67e11,
    eaCathodeJMol: 1.396e5,
    separatorMeltC: 165
  },
  NCA: {
    name: 'NCA',
    cellMassKg: 0.069,
    cpJKgK: 975,
    ratedAh: 4.9,
    dOcvDtVK: -0.00045,
    hSeiJKg: 2.57e5,
    aSeiS: 1.667e15,
    eaSeiJMol: 1.34e5,
    hAnodeJKg: 1.65e6,
    aAnodeS: 2.2e13,
    eaAnodeJMol: 1.345e5,
    hCathodeJKg: 4.85e5,
    aCathodeS: 8.5e11,
    eaCathodeJMol: 1.37e5,
    separatorMeltC: 160
  },
  LCO: {
    name: 'LCO',
    cellMassKg: 0.056,
    cpJKgK: 990,
    ratedAh: 4.2,
    dOcvDtVK: -0.00038,
    hSeiJKg: 2.57e5,
    aSeiS: 1.667e15,
    eaSeiJMol: 1.3508e5,
    hAnodeJKg: 1.55e6,
    aAnodeS: 2.0e13,
    eaAnodeJMol: 1.35e5,
    hCathodeJKg: 3.14e5,
    aCathodeS: 6.67e11,
    eaCathodeJMol: 1.396e5,
    separatorMeltC: 155
  },
  LFP: {
    name: 'LFP',
    cellMassKg: 0.088,
    cpJKgK: 1050,
    ratedAh: 3.2,
    dOcvDtVK: -0.00018,
    hSeiJKg: 1.80e5,
    aSeiS: 8.0e14,
    eaSeiJMol: 1.38e5,
    hAnodeJKg: 6.20e5,
    aAnodeS: 6.5e12,
    eaAnodeJMol: 1.42e5,
    hCathodeJKg: 6.80e4,
    aCathodeS: 1.8e10,
    eaCathodeJMol: 1.58e5,
    separatorMeltC: 170
  }
};

export function calculateBernardiHeatWatts(kinetics, tempC, cRate, dcirMohm) {
  const iAmps = cRate * kinetics.ratedAh;
  const tK = Math.max(250, tempC + 273.15);
  const rOhm = (dcirMohm / 1000) * Math.pow(298.15 / tK, 0.45);
  const qJoule = iAmps * iAmps * rOhm;
  const qEntropic = -iAmps * tK * kinetics.dOcvDtVK;
  return Math.max(0, qJoule + qEntropic);
}

export function exothermicPowerAndRates(kinetics, tempC, cSei, cAnode, alphaCathode, rShortOhm) {
  const tK = Math.max(200, tempC + 273.15);
  const dcSei =
    tempC > 65 && cSei > 1e-5
      ? -kinetics.aSeiS * Math.exp(-kinetics.eaSeiJMol / (R_GAS * tK)) * cSei
      : 0;
  const dcAnode =
    tempC > 95 && cAnode > 1e-5
      ? -kinetics.aAnodeS * Math.exp(-kinetics.eaAnodeJMol / (R_GAS * tK)) * cAnode
      : 0;
  const dAlphaCat =
    tempC > 145 && alphaCathode < 0.9999
      ? kinetics.aCathodeS *
        Math.exp(-kinetics.eaCathodeJMol / (R_GAS * tK)) *
        Math.max(0.01, alphaCathode) *
        (1 - alphaCathode)
      : 0;

  const qSei = -dcSei * kinetics.cellMassKg * 0.10 * kinetics.hSeiJKg;
  const qAnode = -dcAnode * kinetics.cellMassKg * 0.18 * kinetics.hAnodeJKg;
  const qCathode = dAlphaCat * kinetics.cellMassKg * 0.32 * kinetics.hCathodeJKg;
  const qShort =
    rShortOhm > 0.01 && (tempC >= kinetics.separatorMeltC || rShortOhm <= 1.2)
      ? (3.85 * 3.85) / (tempC >= kinetics.separatorMeltC ? rShortOhm : rShortOhm * 1.6)
      : 0;

  return {
    qExo: qSei + qAnode + qCathode + qShort,
    dcSei,
    dcAnode,
    dAlphaCat
  };
}

export function findSemenovCriticalTemperature(kinetics, tAmbC, cRate, dcirMohm, hConvWK, rShortOhm = 0.8) {
  for (let t = Math.max(25, tAmbC); t <= 320; t += 1) {
    const q1 =
      exothermicPowerAndRates(kinetics, t, 0.15, 0.75, 0.04, rShortOhm).qExo +
      calculateBernardiHeatWatts(kinetics, t, cRate, dcirMohm);
    const q2 =
      exothermicPowerAndRates(kinetics, t + 1, 0.15, 0.75, 0.04, rShortOhm).qExo +
      calculateBernardiHeatWatts(kinetics, t + 1, cRate, dcirMohm);
    if (q2 - q1 >= hConvWK && q1 > hConvWK * (t - tAmbC)) {
      return t;
    }
  }
  return 300;
}

export function integrateRunawayRk4(
  kinetics,
  tInitC,
  tAmbC,
  cRate,
  dcirMohm,
  hConvWK,
  rShortOhm,
  totalTimeS = 1200,
  dtS = 2.0
) {
  const tStart = performance.now();
  const steps = Math.ceil(totalTimeS / dtS);
  const out = [];

  let tC = tInitC;
  let cSei = 0.15;
  let cAnode = 0.75;
  let alphaCat = 0.04;
  const capJK = kinetics.cellMassKg * kinetics.cpJKgK;

  const deriv = (tc, cs, ca, ac) => {
    const { qExo, dcSei, dcAnode, dAlphaCat } = exothermicPowerAndRates(
      kinetics,
      tc,
      cs,
      ca,
      ac,
      rShortOhm
    );
    const qb = calculateBernardiHeatWatts(kinetics, tc, cRate, dcirMohm);
    const qc = hConvWK * (tc - tAmbC);
    return [(qExo + qb - qc) / capJK, dcSei, dcAnode, dAlphaCat];
  };

  for (let i = 0; i <= steps; i++) {
    const timeS = i * dtS;
    const { qExo } = exothermicPowerAndRates(kinetics, tC, cSei, cAnode, alphaCat, rShortOhm);
    const qBern = calculateBernardiHeatWatts(kinetics, tC, cRate, dcirMohm);
    const qGen = qExo + qBern;
    const qCool = hConvWK * (tC - tAmbC);
    const dtDtS = (qGen - qCool) / capJK;

    out.push({
      timeS,
      tempC: Math.round(tC * 100) / 100,
      dtDtCPerMin: Math.round(dtDtS * 60 * 100) / 100,
      qGenWatts: Math.round(qGen * 100) / 100,
      qCoolWatts: Math.round(qCool * 100) / 100,
      cSei,
      cAnode,
      alphaCathode: alphaCat
    });

    if (tC >= 750) break;

    const sub = tC > 130 ? 30 : 4;
    const h = dtS / sub;
    for (let s = 0; s < sub; s++) {
      const [k1t, k1s, k1a, k1c] = deriv(tC, cSei, cAnode, alphaCat);
      const [k2t, k2s, k2a, k2c] = deriv(
        Math.min(800, tC + 0.5 * h * k1t),
        Math.min(1, Math.max(0, cSei + 0.5 * h * k1s)),
        Math.min(1, Math.max(0, cAnode + 0.5 * h * k1a)),
        Math.min(1, Math.max(0, alphaCat + 0.5 * h * k1c))
      );
      const [k3t, k3s, k3a, k3c] = deriv(
        Math.min(800, tC + 0.5 * h * k2t),
        Math.min(1, Math.max(0, cSei + 0.5 * h * k2s)),
        Math.min(1, Math.max(0, cAnode + 0.5 * h * k2a)),
        Math.min(1, Math.max(0, alphaCat + 0.5 * h * k2c))
      );
      const [k4t, k4s, k4a, k4c] = deriv(
        Math.min(800, tC + h * k3t),
        Math.min(1, Math.max(0, cSei + h * k3s)),
        Math.min(1, Math.max(0, cAnode + h * k3a)),
        Math.min(1, Math.max(0, alphaCat + h * k3c))
      );

      tC = Math.min(780, tC + (h / 6) * (k1t + 2 * k2t + 2 * k3t + k4t));
      cSei = Math.min(1, Math.max(0, cSei + (h / 6) * (k1s + 2 * k2s + 2 * k3s + k4s)));
      cAnode = Math.min(1, Math.max(0, cAnode + (h / 6) * (k1a + 2 * k2a + 2 * k3a + k4a)));
      alphaCat = Math.min(1, Math.max(0, alphaCat + (h / 6) * (k1c + 2 * k2c + 2 * k3c + k4c)));
      if (tC >= 780) break;
    }
  }

  return {
    steps: out,
    execMs: Math.round((performance.now() - tStart) * 1000) / 1000
  };
}

export function platingSafeChargeCRate(tempC, socPct) {
  const tK = Math.max(230, tempC + 273.15);
  const arrheniusDiff = Math.exp((-36500 / R_GAS) * (1 / tK - 1 / 298.15));
  const socPenalty = Math.min(1, Math.max(0.18, 1 - Math.pow(socPct / 115, 2)));
  return Math.round(Math.min(3.2, Math.max(0.04, 2.4 * arrheniusDiff * socPenalty)) * 100) / 100;
}
