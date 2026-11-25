package handler

import (
	"encoding/json"
	"math"
	"net/http"
	"time"

	goelectrochem "lithio-spectra/go_electrochem"
)

type SolverRequest struct {
	Module           string                        `json:"module"`
	Payload          json.RawMessage               `json:"payload"`
	ValuationInput   *goelectrochem.DegradationInput `json:"valuationInput,omitempty"`
	DcirTimesS       []float64                     `json:"dcirTimesS,omitempty"`
	DcirVoltagesMv   []float64                     `json:"dcirVoltagesMv,omitempty"`
	DcirCurrentsMa   []float64                     `json:"dcirCurrentsMa,omitempty"`
}

type SolverResponse struct {
	Status          string                              `json:"status"`
	Engine          string                              `json:"engine"`
	ProcessedAtUTC  string                              `json:"processedAtUtc"`
	Module          string                              `json:"module"`
	ValuationResult *goelectrochem.ValuationAuditResult `json:"valuationResult,omitempty"`
	QuickR0Mohm     float64                             `json:"quickR0Mohm,omitempty"`
}

// Handler serves Vercel Serverless POST /api/electrochem_battery_solver requests.
func Handler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type")

	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}

	if r.Method == http.MethodGet {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"service": "LITHIO-SPECTRA Go 1.22 Electrochemistry & Valuation Solver",
			"status":  "online",
			"version": "1.24.0",
		})
		return
	}

	var req SolverRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		w.WriteHeader(http.StatusBadRequest)
		_ = json.NewEncoder(w).Encode(map[string]string{"error": "Invalid JSON payload"})
		return
	}

	resp := SolverResponse{
		Status:         "solved",
		Engine:         "go-1.22-electrochem-solver",
		ProcessedAtUTC: time.Now().UTC().Format(time.RFC3339),
		Module:         req.Module,
	}

	if req.ValuationInput != nil {
		res := goelectrochem.EvaluateSeiAndValuation(*req.ValuationInput)
		resp.ValuationResult = &res
	}

	if len(req.DcirVoltagesMv) >= 2 && len(req.DcirCurrentsMa) >= 2 {
		dv := math.Abs(req.DcirVoltagesMv[0] - req.DcirVoltagesMv[1])
		di := math.Abs(req.DcirCurrentsMa[1] - req.DcirCurrentsMa[0])
		if di > 10.0 {
			resp.QuickR0Mohm = math.Round((dv/(di/1000.0))*100) / 100
		}
	}

	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(resp)
}
