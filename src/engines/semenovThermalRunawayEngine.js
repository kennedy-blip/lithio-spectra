import {
  CHEMISTRY_KINETICS,
  calculateBernardiHeatWatts,
  exothermicPowerAndRates,
  findSemenovCriticalTemperature,
  integrateRunawayRk4,
  platingSafeChargeCRate
} from './rustElectrochemBridge.js';

export const ABUSE_SCENARIOS = [
  {
    id: 'fast-charge-hot-bag',
    label: '3C Fast Charge in 42°C Enclosed Bag / Garage',
    tInitC: 48,
    tAmbC: 42,
    cRate: 3.0,
    dcirMohm: 85,
    hConvWK: 0.18,
    rShortOhm: 0.0,
    description: 'Poor convective cooling traps Bernardi I^2R heat until SEI breakdown initiates at 85°C.'
  },
  {
    id: 'dendrite-micro-short',
    label: 'Internal Dendrite Micro-Short (R_short = 0.45 Ω)',
    tInitC: 82,
    tAmbC: 32,
    cRate: 1.5,
    dcirMohm: 110,
    hConvWK: 0.14,
    rShortOhm: 0.45,
    description: 'Plated metallic Li pierces separator above threshold, unleashing localized joule runaway.'
  },
  {
    id: 'adjacent-cell-propagation',
    label: 'External Heater / Adjacent Cell Propagation (115°C)',
    tInitC: 118,
    tAmbC: 75,
    cRate: 0.0,
    dcirMohm: 45,
    hConvWK: 0.22,
    rShortOhm: 1.4,
    description: 'Thermal radiation from a neighboring failing cell pushes core into Stage 2/3 cascade.'
  },
  {
    id: 'normal-ventilated-1c',
    label: 'Normal 1C Ventilated Operation (Safe Equilibrium)',
    tInitC: 28,
    tAmbC: 25,
    cRate: 1.0,
    dcirMohm: 38,
    hConvWK: 0.65,
    rShortOhm: 0.0,
    description: 'Newton cooling line safely intersects Bernardi heat well below T_crit.'
  }
];

export function runSemenovThermalAudit({
  chemistryKey = 'NMC811',
  tInitC = 48,
  tAmbC = 42,
  cRate = 3.0,
  dcirMohm = 85,
  hConvWK = 0.18,
  rShortOhm = 0.8
}) {
  const kinetics = CHEMISTRY_KINETICS[chemistryKey] || CHEMISTRY_KINETICS.NMC811;
  const tCritC = findSemenovCriticalTemperature(kinetics, tAmbC, cRate, dcirMohm, hConvWK, rShortOhm);

  const sim = integrateRunawayRk4(kinetics, tInitC, tAmbC, cRate, dcirMohm, hConvWK, rShortOhm, 1200, 3.0);
  const steps = sim.steps;

  // Build Semenov Q_gen(T) vs Q_cool(T) diagram from tAmb to 260C
  const semenovCurve = [];
  for (let t = Math.max(15, Math.floor(tAmbC)); t <= 260; t += 5) {
    const qExo = exothermicPowerAndRates(kinetics, t, 0.15, 0.75, 0.04, rShortOhm).qExo;
    const qBern = calculateBernardiHeatWatts(kinetics, t, cRate, dcirMohm);
    const qCool = Math.max(0, hConvWK * (t - tAmbC));
    semenovCurve.push({
      tempC: t,
      qGenWatts: Math.round(Math.min(450, qExo + qBern) * 100) / 100,
      qCoolWatts: Math.round(qCool * 100) / 100
    });
  }

  const ventStep = steps.find((s) => s.tempC >= 130);
  const meltStep = steps.find((s) => s.tempC >= kinetics.separatorMeltC);
  const runawayStep = steps.find((s) => s.dtDtCPerMin >= 60 || s.tempC >= 210);
  const peakStep = steps.reduce((best, cur) => (cur.tempC > best.tempC ? cur : best), steps[0]);

  // Sub-zero plating curve across -20C to +45C
  const platingCurve = [];
  for (let tc = -20; tc <= 45; tc += 5) {
    platingCurve.push({
      tempC: tc,
      maxCAt50Soc: platingSafeChargeCRate(tc, 50),
      maxCAt80Soc: platingSafeChargeCRate(tc, 80)
    });
  }

  return {
    kinetics,
    tCritC,
    trajectory: steps,
    semenovCurve,
    platingCurve,
    ventTimeS: ventStep ? ventStep.timeS : null,
    meltTimeS: meltStep ? meltStep.timeS : null,
    runawayTimeS: runawayStep ? runawayStep.timeS : null,
    peakTempC: peakStep.tempC,
    peakRateCPerMin: Math.max(...steps.map((s) => s.dtDtCPerMin)),
    execMs: sim.execMs
  };
}
