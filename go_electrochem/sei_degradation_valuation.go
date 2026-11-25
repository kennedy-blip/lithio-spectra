package goelectrochem

import (
	"math"
)

const gasConstantR = 8.314462618

// DegradationInput configures coupled Schmalstieg/Wang SEI growth & EV valuation.
type DegradationInput struct {
	Chemistry        string  `json:"chemistry"`         // NMC, NCA, LFP, LCO
	AmbientTempC     float64 `json:"ambientTempC"`      // Avg operating ambient C
	SocMinPct        float64 `json:"socMinPct"`         // Lower charge window
	SocMaxPct        float64 `json:"socMaxPct"`         // Upper charge window
	ChargeCRate      float64 `json:"chargeCRate"`       // C-rate (0.3 - 3.0)
	DailyCycles      float64 `json:"dailyCycles"`       // Average cycles per day
	PackCapacityKWh  float64 `json:"packCapacityKwh"`   // Pack kWh (or Wh/1000 for device)
	ReplacementCost  float64 `json:"replacementCostUsd"`
	VehicleAgeYears  float64 `json:"vehicleAgeYears"`
	OdometerMiles    float64 `json:"odometerMiles"`
	ReportedSohPct   float64 `json:"reportedSohPct"`
	DcFastChargePct  float64 `json:"dcFastChargePct"`
}

// TrajectoryPoint captures capacity retention at a specific year.
type TrajectoryPoint struct {
	Year            float64 `json:"year"`
	SohHabitPct     float64 `json:"sohHabitPct"`
	SohBaselinePct  float64 `json:"sohBaselinePct"`
	SeiThicknessNm  float64 `json:"seiThicknessNm"`
	KneeReached     bool    `json:"kneeReached"`
}

// ValuationAuditResult summarizes SEI trajectory and used-EV / device actuarial pricing.
type ValuationAuditResult struct {
	Trajectory          []TrajectoryPoint `json:"trajectory"`
	ExpectedFleetSohPct float64           `json:"expectedFleetSohPct"`
	SohDeltaPct         float64           `json:"sohDeltaPct"`
	FleetPercentile     float64           `json:"fleetPercentile"`
	RemainingYearsTo70  float64           `json:"remainingYearsTo70"`
	WarrantyEligible    bool              `json:"warrantyEligible"`
	RiskReserveUsd      float64           `json:"riskReserveUsd"`
	FairPriceAdjustUsd  float64           `json:"fairPriceAdjustUsd"`
	LifespanMultiplier  float64           `json:"lifespanMultiplier"`
	Verdict             string            `json:"verdict"`
}

func chemistryParams(chem string) (kCal, eaCal, kCyc, eaCyc, zExp float64) {
	switch chem {
	case "LFP":
		return 0.0019, 24500.0, 0.00018, 22400.0, 0.52
	case "NCA":
		return 0.0034, 24100.0, 0.00031, 21800.0, 0.56
	case "LCO":
		return 0.0046, 23800.0, 0.00044, 21200.0, 0.58
	default: // NMC
		return 0.0031, 24200.0, 0.00029, 21900.0, 0.55
	}
}

func computeLossFraction(chem string, tempC, socAvgPct, dodPct, cRate, years, dailyCycles, packKWh float64) (lossPct, seiNm float64) {
	kCal, eaCal, kCyc, eaCyc, zExp := chemistryParams(chem)
	tK := math.Max(253.15, tempC+273.15)
	days := years * 365.25
	if days <= 0 {
		return 0, 12.0
	}

	// Voltage stress factor (Tafel-like anode/cathode potential acceleration above 65% SOC)
	socFactor := math.Exp(1.65 * ((socAvgPct - 50.0) / 100.0))
	calLoss := (kCal * 0.42) * socFactor * math.Exp(-eaCal/gasConstantR*(1.0/tK-1.0/298.15)) * math.Sqrt(days)

	// Cycle fatigue (DoD Wohler + C-rate stress normalized to Full Equivalent Cycles)
	dodFrac := math.Max(0.05, dodPct/100.0)
	fecEq := math.Max(1.0, days*dailyCycles*dodFrac)
	cycLoss := kCyc * 3.6 * math.Pow(dodFrac, 1.38) * math.Exp((-eaCyc+980.0*cRate)/(gasConstantR*tK)+eaCyc/(gasConstantR*298.15)) * math.Pow(fecEq, zExp)

	totalLoss := math.Min(58.0, (calLoss+cycLoss)*100.0)
	// Non-linear aging knee acceleration beyond 22% cumulative loss
	if totalLoss > 22.0 {
		totalLoss += math.Pow(totalLoss-22.0, 1.24) * 0.35
	}
	totalLoss = math.Min(65.0, totalLoss)
	sei := 12.0 + totalLoss*4.8
	return totalLoss, sei
}

// EvaluateSeiAndValuation computes 8-year SEI fade comparison and Used-EV/Device fair-value audit.
func EvaluateSeiAndValuation(in DegradationInput) ValuationAuditResult {
	dodHabit := math.Max(10.0, in.SocMaxPct-in.SocMinPct)
	socAvgHabit := (in.SocMaxPct + in.SocMinPct) * 0.5

	trajectory := make([]TrajectoryPoint, 0, 17)
	var yearsTo70Habit, yearsTo70Base float64 = 12.0, 12.0
	foundHabit70, foundBase70 := false, false

	for step := 0; step <= 16; step++ {
		yr := float64(step) * 0.5
		lossHabit, seiNm := computeLossFraction(in.Chemistry, in.AmbientTempC, socAvgHabit, dodHabit, in.ChargeCRate, yr, in.DailyCycles, in.PackCapacityKWh)
		lossBase, _ := computeLossFraction(in.Chemistry, math.Max(in.AmbientTempC+5.0, 30.0), 72.0, 90.0, math.Max(in.ChargeCRate, 1.5), yr, in.DailyCycles, in.PackCapacityKWh)

		sohHabit := math.Max(35.0, 100.0-lossHabit)
		sohBase := math.Max(35.0, 100.0-lossBase)

		if !foundHabit70 && sohHabit <= 70.0 {
			yearsTo70Habit = yr
			foundHabit70 = true
		}
		if !foundBase70 && sohBase <= 70.0 {
			yearsTo70Base = yr
			foundBase70 = true
		}

		trajectory = append(trajectory, TrajectoryPoint{
			Year:           yr,
			SohHabitPct:    math.Round(sohHabit*100) / 100,
			SohBaselinePct: math.Round(sohBase*100) / 100,
			SeiThicknessNm: math.Round(seiNm*10) / 10,
			KneeReached:    sohHabit < 78.0,
		})
	}

	// Expected fleet median SOH at given vehicle age & mileage
	eqCycles := (in.OdometerMiles / 260.0) + in.VehicleAgeYears*45.0
	effDaily := math.Max(0.15, eqCycles/math.Max(1.0, in.VehicleAgeYears*365.25))
	dcPenaltyTemp := in.AmbientTempC + (in.DcFastChargePct/100.0)*9.5
	fleetLoss, _ := computeLossFraction(in.Chemistry, dcPenaltyTemp, 58.0, 62.0, 0.8+(in.DcFastChargePct/100.0)*1.4, in.VehicleAgeYears, effDaily, in.PackCapacityKWh)
	expectedSoh := math.Max(50.0, 100.0-fleetLoss)

	sohDelta := in.ReportedSohPct - expectedSoh
	percentile := math.Max(2.0, math.Min(99.0, 50.0+sohDelta*4.8))

	warrantyEligible := in.ReportedSohPct < 70.0 && in.VehicleAgeYears <= 8.0 && in.OdometerMiles <= 100000.0

	// Actuarial replacement risk reserve & fair negotiation deduction
	degradationFraction := math.Max(0.0, (100.0-in.ReportedSohPct)/30.0)
	riskReserve := in.ReplacementCost * math.Min(1.0, math.Pow(degradationFraction, 1.35)*0.62)
	if warrantyEligible {
		riskReserve *= 0.25
	}

	fairAdjust := 0.0
	if sohDelta < -1.5 {
		fairAdjust = -math.Abs(sohDelta) / 30.0 * in.ReplacementCost * 1.15
	} else if sohDelta > 2.0 {
		fairAdjust = (sohDelta / 30.0) * in.ReplacementCost * 0.45
	}

	lifespanMult := math.Max(1.0, math.Min(4.2, yearsTo70Habit/math.Max(1.5, yearsTo70Base)))

	verdict := "NOMINAL FLEET HEALTH — Matches expected SEI passivation curve"
	if warrantyEligible {
		verdict = "WARRANTY CLAIM ELIGIBLE (<70% SOH) — OEM Pack Replacement Recommended"
	} else if sohDelta < -5.0 {
		verdict = "ACCELERATED DEGRADATION ALERT — High-Risk Knee-Point Approach; Negotiate Price Deduction"
	} else if sohDelta > 3.5 {
		verdict = "EXCEPTIONAL PACK RETENTION — Top Decile Low-Stress Charging History"
	}

	return ValuationAuditResult{
		Trajectory:          trajectory,
		ExpectedFleetSohPct: math.Round(expectedSoh*100) / 100,
		SohDeltaPct:         math.Round(sohDelta*100) / 100,
		FleetPercentile:     math.Round(percentile*10) / 10,
		RemainingYearsTo70:  math.Round(yearsTo70Habit*10) / 10,
		WarrantyEligible:    warrantyEligible,
		RiskReserveUsd:      math.Round(riskReserve),
		FairPriceAdjustUsd:  math.Round(fairAdjust),
		LifespanMultiplier:  math.Round(lifespanMult*100) / 100,
		Verdict:             verdict,
	}
}
