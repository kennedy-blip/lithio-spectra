//! LITHIO-SPECTRA Core Electrochemical Computation Crate
//!
//! Exports C-ABI / WebAssembly-compatible entrypoints for:
//!  1. 2nd-Order Thevenin (2RC) Equivalent Circuit Recursive Least Squares (RLS)
//!  2. Cole-Cole Nyquist Impedance Spectrum Z(omega) Synthesis
//!  3. Incremental Capacity Analysis (ICA dQ/dV) LLI / LAM Deconvolution
//!  4. 4-Stage Arrhenius Exothermic Decomposition & Semenov Thermal Runaway RK4 Integrator

pub mod semenov_arrhenius_runaway;
pub mod thevenin_dcir_ica;

pub use semenov_arrhenius_runaway::{
    calculate_bernardi_heat_watts, find_semenov_critical_temperature,
    integrate_runaway_rk4, plating_safe_charge_c_rate, ChemistryKinetics, RunawayStep,
};
pub use thevenin_dcir_ica::{
    compute_nyquist_cole_cole, deconvolve_dq_dv_peaks, identify_thevenin_2rc_rls,
    ocv_from_soc_nmc_graphite, IcaPeakMetrics, NyquistPoint, Thevenin2RcParams,
};

/// C-ABI / WASM export: Estimates R0 (mOhm), R1 (mOhm), C1 (F), R2 (mOhm), C2 (F)
/// from voltage (mV), current (mA), and time (s) pulse transient arrays.
/// Writes 5 f64 values into `out_params_ptr`: [r0_mohm, r1_mohm, c1_f, r2_mohm, c2_f].
#[no_mangle]
pub extern "C" fn ls_identify_thevenin_2rc(
    times_ptr: *const f64,
    voltages_mv_ptr: *const f64,
    currents_ma_ptr: *const f64,
    len: usize,
    soc_pct: f64,
    out_params_ptr: *mut f64,
) -> i32 {
    if times_ptr.is_null()
        || voltages_mv_ptr.is_null()
        || currents_ma_ptr.is_null()
        || out_params_ptr.is_null()
        || len < 8
    {
        return -1;
    }

    let times = unsafe { std::slice::from_raw_parts(times_ptr, len) };
    let voltages_mv = unsafe { std::slice::from_raw_parts(voltages_mv_ptr, len) };
    let currents_ma = unsafe { std::slice::from_raw_parts(currents_ma_ptr, len) };
    let out = unsafe { std::slice::from_raw_parts_mut(out_params_ptr, 5) };

    let params = identify_thevenin_2rc_rls(times, voltages_mv, currents_ma, soc_pct);
    out[0] = params.r0_mohm;
    out[1] = params.r1_mohm;
    out[2] = params.c1_farads;
    out[3] = params.r2_mohm;
    out[4] = params.c2_farads;
    0
}

/// C-ABI / WASM export: Computes Semenov critical runaway temperature (degC)
/// and time-to-runaway (seconds) for a given chemistry code (0=NMC811, 1=NCA, 2=LCO, 3=LFP).
#[no_mangle]
pub extern "C" fn ls_semenov_critical_assessment(
    chemistry_code: u32,
    t_amb_c: f64,
    c_rate: f64,
    dcir_mohm: f64,
    h_conv_w_k: f64,
    out_metrics_ptr: *mut f64,
) -> i32 {
    if out_metrics_ptr.is_null() {
        return -1;
    }
    let kinetics = match chemistry_code {
        0 => ChemistryKinetics::nmc811(),
        1 => ChemistryKinetics::nca(),
        2 => ChemistryKinetics::lco(),
        _ => ChemistryKinetics::lfp(),
    };
    let t_crit_c = find_semenov_critical_temperature(&kinetics, t_amb_c, c_rate, dcir_mohm, h_conv_w_k);
    let traj = integrate_runaway_rk4(&kinetics, t_amb_c + 12.0, t_amb_c, c_rate, dcir_mohm, h_conv_w_k, 0.0, 1800.0, 2.0);
    let time_to_runaway_s = traj
        .iter()
        .find(|s| s.dt_dt_c_per_min >= 60.0 || s.temp_c >= 210.0)
        .map(|s| s.time_s)
        .unwrap_or(-1.0);
    let max_temp_c = traj.iter().map(|s| s.temp_c).fold(t_amb_c, f64::max);

    let out = unsafe { std::slice::from_raw_parts_mut(out_metrics_ptr, 3) };
    out[0] = t_crit_c;
    out[1] = time_to_runaway_s;
    out[2] = max_temp_c;
    0
}
