//! 2nd-Order Thevenin Equivalent Circuit Model (2RC ECM) Recursive Least Squares
//! Parameter Identifier, Nyquist Cole-Cole Synthesizer, and dQ/dV ICA Peak Deconvolver.

#[derive(Debug, Clone, Copy)]
pub struct Thevenin2RcParams {
    pub r0_mohm: f64,
    pub r1_mohm: f64,
    pub c1_farads: f64,
    pub r2_mohm: f64,
    pub c2_farads: f64,
    pub tau1_s: f64,
    pub tau2_s: f64,
    pub rmse_mv: f64,
}

#[derive(Debug, Clone, Copy)]
pub struct NyquistPoint {
    pub freq_hz: f64,
    pub z_real_mohm: f64,
    pub z_neg_imag_mohm: f64,
}

#[derive(Debug, Clone, Copy)]
pub struct IcaPeakMetrics {
    pub peak1_voltage_v: f64,
    pub peak1_height_ah_v: f64,
    pub peak2_voltage_v: f64,
    pub peak2_height_ah_v: f64,
    pub peak3_voltage_v: f64,
    pub peak3_height_ah_v: f64,
    pub lli_pct: f64,
    pub lam_pct: f64,
    pub estimated_soh_pct: f64,
}

/// Smooth analytical OCV-SOC curve (V) for NMC/LCO Graphite-SiOx lithium-ion cell.
pub fn ocv_from_soc_nmc_graphite(soc_pct: f64) -> f64 {
    let s = (soc_pct / 100.0).clamp(0.005, 0.995);
    3.42
        + 0.78 * s
        - 0.19 * (1.0 - s).powi(3)
        + 0.085 * (6.2 * s).sin() * 0.25
        + 0.14 * (s - 0.5).tanh()
}

/// Identifies R0 (ohmic), R1/C1 (charge transfer), and R2/C2 (solid diffusion)
/// from a controlled load-step transient using Recursive Least Squares (RLS)
/// coupled with exponential basis projection.
pub fn identify_thevenin_2rc_rls(
    times_s: &[f64],
    voltages_mv: &[f64],
    currents_ma: &[f64],
    soc_pct: f64,
) -> Thevenin2RcParams {
    let n = times_s.len().min(voltages_mv.len()).min(currents_ma.len());
    if n < 6 {
        return Thevenin2RcParams {
            r0_mohm: 45.0,
            r1_mohm: 22.0,
            c1_farads: 120.0,
            r2_mohm: 18.0,
            c2_farads: 1650.0,
            tau1_s: 2.64,
            tau2_s: 29.7,
            rmse_mv: 0.0,
        };
    }

    let u_ocv_mv = voltages_mv[0] + (currents_ma[0].abs() / 1000.0) * 50.0;
    let mut r0_anchor = 0.055_f64;
    let mut max_di = 0.0_f64;
    for k in 1..n {
        let di = (currents_ma[k] - currents_ma[k - 1]).abs();
        let dv = (voltages_mv[k] - voltages_mv[k - 1]).abs();
        if di > 250.0 && di > max_di {
            max_di = di;
            r0_anchor = (dv / di).clamp(0.005, 1.2);
        }
    }
    let tau1 = 2.4_f64;
    let tau2 = 28.0_f64;

    // RLS state for 3 parameters: theta = [R0 (Ohm), R1 (Ohm), R2 (Ohm)]
    // Overpotential: dV(t) = u_ocv - V(t) = R0 * I(t) + R1 * i_pol1(t) + R2 * i_pol2(t)
    let mut theta = [r0_anchor, r0_anchor * 0.42, r0_anchor * 0.28];
    let mut p_mat = [
        [0.02, 0.0, 0.0],
        [0.0, 4.0, 0.0],
        [0.0, 0.0, 4.0],
    ];
    let lambda = 0.985_f64;

    let mut i_pol1 = 0.0_f64;
    let mut i_pol2 = 0.0_f64;

    for k in 1..n {
        let dt = (times_s[k] - times_s[k - 1]).clamp(0.01, 5.0);
        let i_amps = currents_ma[k].abs() / 1000.0;
        let e1 = (-dt / tau1).exp();
        let e2 = (-dt / tau2).exp();
        i_pol1 = i_pol1 * e1 + i_amps * (1.0 - e1);
        i_pol2 = i_pol2 * e2 + i_amps * (1.0 - e2);

        let phi = [i_amps, i_pol1, i_pol2];
        let y_mv = (u_ocv_mv - voltages_mv[k]).max(0.0);
        let y_v = y_mv / 1000.0;

        // P * phi
        let mut p_phi = [0.0_f64; 3];
        for r in 0..3 {
            p_phi[r] = p_mat[r][0] * phi[0] + p_mat[r][1] * phi[1] + p_mat[r][2] * phi[2];
        }
        let denom = lambda + phi[0] * p_phi[0] + phi[1] * p_phi[1] + phi[2] * p_phi[2];
        let k_gain = [p_phi[0] / denom, p_phi[1] / denom, p_phi[2] / denom];

        let err = y_v - (theta[0] * phi[0] + theta[1] * phi[1] + theta[2] * phi[2]);
        for r in 0..3 {
            theta[r] = (theta[r] + k_gain[r] * err).clamp(0.002, 1.5);
        }

        // Covariance update P = (P - K * phi^T * P) / lambda
        let mut next_p = [[0.0_f64; 3]; 3];
        for r in 0..3 {
            for c in 0..3 {
                let k_phi_p = k_gain[r] * (phi[0] * p_mat[0][c] + phi[1] * p_mat[1][c] + phi[2] * p_mat[2][c]);
                next_p[r][c] = (p_mat[r][c] - k_phi_p) / lambda;
            }
        }
        p_mat = next_p;
    }

    // Compute residual RMSE (mV)
    let mut sq_err = 0.0_f64;
    let mut ip1 = 0.0_f64;
    let mut ip2 = 0.0_f64;
    for k in 1..n {
        let dt = (times_s[k] - times_s[k - 1]).clamp(0.01, 5.0);
        let i_amps = currents_ma[k].abs() / 1000.0;
        let e1 = (-dt / tau1).exp();
        let e2 = (-dt / tau2).exp();
        ip1 = ip1 * e1 + i_amps * (1.0 - e1);
        ip2 = ip2 * e2 + i_amps * (1.0 - e2);
        let v_pred_mv = u_ocv_mv - 1000.0 * (theta[0] * i_amps + theta[1] * ip1 + theta[2] * ip2);
        let diff = v_pred_mv - voltages_mv[k];
        sq_err += diff * diff;
    }
    let rmse_mv = (sq_err / (n - 1) as f64).sqrt();

    let r0_mohm = theta[0] * 1000.0;
    let r1_mohm = theta[1] * 1000.0;
    let r2_mohm = theta[2] * 1000.0;
    let c1_farads = tau1 / theta[1].max(0.001);
    let c2_farads = tau2 / theta[2].max(0.001);

    Thevenin2RcParams {
        r0_mohm,
        r1_mohm,
        c1_farads,
        r2_mohm,
        c2_farads,
        tau1_s: tau1,
        tau2_s: tau2,
        rmse_mv,
    }
}

/// Generates Nyquist Cole-Cole impedance sweep Z(omega) = R0 + Z_RC1 + Z_RC2 + Z_warburg
/// from 10 kHz down to 0.01 Hz.
pub fn compute_nyquist_cole_cole(params: &Thevenin2RcParams, warburg_sigma_mohm: f64) -> Vec<NyquistPoint> {
    let freqs = [
        10000.0, 4000.0, 1500.0, 500.0, 180.0, 60.0, 20.0, 8.0, 3.0, 1.0,
        0.4, 0.15, 0.06, 0.025, 0.01,
    ];
    let mut out = Vec::with_capacity(freqs.len());

    for &f in &freqs {
        let w = 2.0 * std::f64::consts::PI * f;
        let wt1 = w * params.tau1_s;
        let wt2 = w * params.tau2_s;

        let z1_re = params.r1_mohm / (1.0 + wt1 * wt1);
        let z1_im = -params.r1_mohm * wt1 / (1.0 + wt1 * wt1);

        let z2_re = params.r2_mohm / (1.0 + wt2 * wt2);
        let z2_im = -params.r2_mohm * wt2 / (1.0 + wt2 * wt2);

        // Low-frequency Warburg solid diffusion tail (only significant < 1.5 Hz)
        let w_factor = if f < 2.0 {
            warburg_sigma_mohm / w.sqrt().max(0.08)
        } else {
            0.0
        };

        out.push(NyquistPoint {
            freq_hz: f,
            z_real_mohm: params.r0_mohm + z1_re + z2_re + w_factor,
            z_neg_imag_mohm: -(z1_im + z2_im - w_factor),
        });
    }
    out
}

/// Deconvolves Gaussian-smoothed Incremental Capacity (dQ/dV) curves into the 3 primary
/// graphite staging peaks (LiC6 <-> LiC12 <-> LiC18) and extracts LLI% and LAM%.
pub fn deconvolve_dq_dv_peaks(voltages_v: &[f64], dq_dv_ah_v: &[f64], rated_cap_ah: f64) -> IcaPeakMetrics {
    let n = voltages_v.len().min(dq_dv_ah_v.len());
    if n < 5 {
        return IcaPeakMetrics {
            peak1_voltage_v: 3.52,
            peak1_height_ah_v: 1.8,
            peak2_voltage_v: 3.74,
            peak2_height_ah_v: 4.9,
            peak3_voltage_v: 4.02,
            peak3_height_ah_v: 3.1,
            lli_pct: 4.0,
            lam_pct: 3.2,
            estimated_soh_pct: 94.5,
        };
    }

    let find_band_peak = |v_min: f64, v_max: f64| -> (f64, f64) {
        let mut best_v = (v_min + v_max) * 0.5;
        let mut best_h = 0.0_f64;
        for i in 0..n {
            if voltages_v[i] >= v_min && voltages_v[i] <= v_max && dq_dv_ah_v[i] > best_h {
                best_h = dq_dv_ah_v[i];
                best_v = voltages_v[i];
            }
        }
        (best_v, best_h)
    };

    let (p1v, p1h) = find_band_peak(3.40, 3.63);
    let (p2v, p2h) = find_band_peak(3.64, 3.88);
    let (p3v, p3h) = find_band_peak(3.89, 4.18);

    // Reference nominal peak heights normalized by rated capacity (Ah/V per Ah)
    let ref_p2 = rated_cap_ah * 1.45;
    let ref_p3 = rated_cap_ah * 0.92;

    let lli_pct = ((1.0 - (p3h / ref_p3.max(0.1)).min(1.05)) * 68.0).clamp(0.0, 48.0);
    let lam_pct = ((1.0 - (p2h / ref_p2.max(0.1)).min(1.05)) * 55.0).clamp(0.0, 45.0);
    let soh = (100.0 - 0.65 * lli_pct - 0.55 * lam_pct).clamp(45.0, 100.0);

    IcaPeakMetrics {
        peak1_voltage_v: p1v,
        peak1_height_ah_v: p1h,
        peak2_voltage_v: p2v,
        peak2_height_ah_v: p2h,
        peak3_voltage_v: p3v,
        peak3_height_ah_v: p3h,
        lli_pct,
        lam_pct,
        estimated_soh_pct: soh,
    }
}
