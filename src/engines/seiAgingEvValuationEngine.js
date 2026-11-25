/**
 * Arrhenius SEI Film Growth Lifespan Optimizer (20-80% vs 0-100%)
 * & Used-EV / Used-Device Battery Pack Actuarial Valuation Auditor.
 * Mirrors go_electrochem/sei_degradation_valuation.go for 100% offline parity.
 */

const R_GAS = 8.314462618;

export const VEHICLE_AND_DEVICE_PRESETS = [
  {
    id: 'tesla-model-3-lr',
    name: 'Tesla Model 3 / Y Long Range (NCA/NMC)',
    category: 'Used EV',
    chemistry: 'NCA',
    packCapacityKwh: 75,
    replacementCostUsd: 16500,
    vehicleAgeYears: 4.2,
    odometerMiles: 52000,
    reportedSohPct: 89.5,
    dcFastChargePct: 28,
    ambientTempC: 24
  },
  {
    id: 'nissan-leaf-degraded',
    name: 'Nissan Leaf 40 kWh (Passive Air-Cooled — High Heat)',
    category: 'Used EV',
    chemistry: 'NMC',
    packCapacityKwh: 40,
    replacementCostUsd: 11200,
    vehicleAgeYears: 5.5,
    odometerMiles: 58000,
    reportedSohPct: 73.2,
    dcFastChargePct: 54,
    ambientTempC: 33
  },
  {
    id: 'hyundai-ioniq5-lfp-or-nmc',
    name: 'Hyundai Ioniq 5 / Kia EV6 (800V E-GMP Pack)',
    category: 'Used EV',
    chemistry: 'NMC',
    packCapacityKwh: 77.4,
    replacementCostUsd: 18900,
    vehicleAgeYears: 2.8,
    odometerMiles: 34000,
    reportedSohPct: 94.8,
    dcFastChargePct: 35,
    ambientTempC: 22
  },
  {
    id: 'used-flagship-phone',
    name: 'Used Flagship Smartphone / Ultrabook Pack',
    category: 'Used Consumer Device',
    chemistry: 'LCO',
    packCapacityKwh: 0.018,
    replacementCostUsd: 129,
    vehicleAgeYears: 2.5,
    odometerMiles: 28000, // mapped to ~360 cycles equivalent
    reportedSohPct: 79.0,
    dcFastChargePct: 65,
    ambientTempC: 29
  }
];

function chemistryParams(chem) {
  switch (chem) {
    case 'LFP':
      return { kCal: 0.0019, eaCal: 24500, kCyc: 0.00018, eaCyc: 22400, zExp: 0.52 };
    case 'NCA':
      return { kCal: 0.0034, eaCal: 24100, kCyc: 0.00031, eaCyc: 21800, zExp: 0.56 };
    case 'LCO':
      return { kCal: 0.0046, eaCal: 23800, kCyc: 0.00044, eaCyc: 21200, zExp: 0.58 };
    default:
      return { kCal: 0.0031, eaCal: 24200, kCyc: 0.00029, eaCyc: 21900, zExp: 0.55 };
  }
}

export function computeLossFraction(chem, tempC, socAvgPct, dodPct, cRate, years, dailyCycles, packKwh) {
  const { kCal, eaCal, kCyc, eaCyc, zExp } = chemistryParams(chem);
  const tK = Math.max(253.15, tempC + 273.15);
  const days = years * 365.25;
  if (days <= 0) return { lossPct: 0, seiNm: 12 };

  const socFactor = Math.exp(1.65 * ((socAvgPct - 50) / 100));
  const calLoss =
    (kCal * 0.42) * socFactor * Math.exp((-eaCal / R_GAS) * (1 / tK - 1 / 298.15)) * Math.sqrt(days);

  const dodFrac = Math.max(0.05, dodPct / 100);
  const fecEq = Math.max(1, days * dailyCycles * dodFrac);
  const cycLoss =
    kCyc *
    3.6 *
    Math.pow(dodFrac, 1.38) *
    Math.exp((-eaCyc + 980 * cRate) / (R_GAS * tK) + eaCyc / (R_GAS * 298.15)) *
    Math.pow(fecEq, zExp);

  let totalLoss = Math.min(58, (calLoss + cycLoss) * 100);
  if (totalLoss > 22) {
    totalLoss += Math.pow(totalLoss - 22, 1.24) * 0.35;
  }
  totalLoss = Math.min(65, totalLoss);
  return {
    lossPct: totalLoss,
    seiNm: 12 + totalLoss * 4.8
  };
}

export function evaluateSeiAndValuation(input) {
  const {
    chemistry = 'NMC',
    ambientTempC = 24,
    socMinPct = 20,
    socMaxPct = 80,
    chargeCRate = 0.6,
    dailyCycles = 0.55,
    packCapacityKwh = 75,
    replacementCostUsd = 16500,
    vehicleAgeYears = 4.0,
    odometerMiles = 48000,
    reportedSohPct = 89.5,
    dcFastChargePct = 25
  } = input;

  const dodHabit = Math.max(10, socMaxPct - socMinPct);
  const socAvgHabit = (socMaxPct + socMinPct) * 0.5;

  const trajectory = [];
  let yearsTo70Habit = 12.0;
  let yearsTo70Base = 12.0;
  let foundHabit = false;
  let foundBase = false;

  for (let step = 0; step <= 16; step++) {
    const year = step * 0.5;
    const habit = computeLossFraction(
      chemistry,
      ambientTempC,
      socAvgHabit,
      dodHabit,
      chargeCRate,
      year,
      dailyCycles,
      packCapacityKwh
    );
    const base = computeLossFraction(
      chemistry,
      Math.max(ambientTempC + 5, 30),
      72,
      90,
      Math.max(chargeCRate, 1.5),
      year,
      dailyCycles,
      packCapacityKwh
    );

    const sohHabitPct = Math.round(Math.max(35, 100 - habit.lossPct) * 100) / 100;
    const sohBaselinePct = Math.round(Math.max(35, 100 - base.lossPct) * 100) / 100;

    if (!foundHabit && sohHabitPct <= 70) {
      yearsTo70Habit = year;
      foundHabit = true;
    }
    if (!foundBase && sohBaselinePct <= 70) {
      yearsTo70Base = year;
      foundBase = true;
    }

    trajectory.push({
      year,
      sohHabitPct,
      sohBaselinePct,
      seiThicknessNm: Math.round(habit.seiNm * 10) / 10,
      kneeReached: sohHabitPct < 78
    });
  }

  const eqCycles = odometerMiles / 260 + vehicleAgeYears * 45;
  const effDaily = Math.max(0.15, eqCycles / Math.max(1, vehicleAgeYears * 365.25));
  const dcPenaltyTemp = ambientTempC + (dcFastChargePct / 100) * 9.5;
  const fleet = computeLossFraction(
    chemistry,
    dcPenaltyTemp,
    58,
    62,
    0.8 + (dcFastChargePct / 100) * 1.4,
    vehicleAgeYears,
    effDaily,
    packCapacityKwh
  );

  const expectedFleetSohPct = Math.round(Math.max(50, 100 - fleet.lossPct) * 100) / 100;
  const sohDeltaPct = Math.round((reportedSohPct - expectedFleetSohPct) * 100) / 100;
  const fleetPercentile = Math.round(Math.min(99, Math.max(2, 50 + sohDeltaPct * 4.8)) * 10) / 10;
  const warrantyEligible = reportedSohPct < 70 && vehicleAgeYears <= 8 && odometerMiles <= 100000;

  const degFrac = Math.max(0, (100 - reportedSohPct) / 30);
  let riskReserveUsd = replacementCostUsd * Math.min(1, Math.pow(degFrac, 1.35) * 0.62);
  if (warrantyEligible) riskReserveUsd *= 0.25;

  let fairPriceAdjustUsd = 0;
  if (sohDeltaPct < -1.5) {
    fairPriceAdjustUsd = -(Math.abs(sohDeltaPct) / 30) * replacementCostUsd * 1.15;
  } else if (sohDeltaPct > 2.0) {
    fairPriceAdjustUsd = (sohDeltaPct / 30) * replacementCostUsd * 0.45;
  }

  const lifespanMultiplier =
    Math.round(Math.min(4.2, Math.max(1.0, yearsTo70Habit / Math.max(1.5, yearsTo70Base))) * 100) / 100;

  let verdict = 'NOMINAL FLEET HEALTH — Matches expected SEI passivation curve';
  if (warrantyEligible) {
    verdict = 'WARRANTY CLAIM ELIGIBLE (<70% SOH) — OEM Pack Replacement Recommended';
  } else if (sohDeltaPct < -5.0) {
    verdict = 'ACCELERATED DEGRADATION ALERT — High-Risk Knee-Point Approach; Negotiate Price Deduction';
  } else if (sohDeltaPct > 3.5) {
    verdict = 'EXCEPTIONAL PACK RETENTION — Top Decile Low-Stress Charging History';
  }

  return {
    trajectory,
    expectedFleetSohPct,
    sohDeltaPct,
    fleetPercentile,
    remainingYearsTo70: yearsTo70Habit,
    warrantyEligible,
    riskReserveUsd: Math.round(riskReserveUsd),
    fairPriceAdjustUsd: Math.round(fairPriceAdjustUsd),
    lifespanMultiplier,
    verdict
  };
}
