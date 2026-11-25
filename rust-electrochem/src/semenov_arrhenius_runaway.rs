//! 4-Stage Arrhenius Exothermic Decomposition & Semenov Thermal Runaway RK4 Integrator
//! Models: (1) SEI Breakdown, (2) Anode-Electrolyte Reaction, (3) Separator Melt,
//! (4) Cathode Lattice O2 Release, plus Bernardi Joule & Entropic Heat Generation.

const R_GAS: f64 = 8.314462618;

#[derive(Debug, Clone, Copy)]
pub struct ChemistryKinetics {
    pub name: &'static str,
    pub cell_mass_kg: f64,
    pub cp_j_kg_k: f64,
    pub rated_ah: f64,
    pub d_ocv_dt_v_k: f64,
    // Stage 1: SEI breakdown
    pub h_sei_j_kg: f64,
    pub a_sei_s: f64,
    pub ea_sei_j_mol: f64,
    // Stage 2: Anode-electrolyte
    pub h_anode_j_kg: f64,
    pub a_anode_s: f64,
    pub ea_anode_j_mol: f64,
    // Stage 3: Cathode O2 decomposition
    pub h_cathode_j_kg: f64,
    pub a_cathode_s: f64,
    pub ea_cathode_j_mol: f64,
    pub separator_melt_c: f64,
}

impl ChemistryKinetics {
    pub fn nmc811() -> Self {
        Self {
            name: "NMC811",
            cell_mass_kg: 0.068,
            cp_j_kg_k: 980.0,
            rated_ah: 5.0,
            d_ocv_dt_v_k: -0.00042,
            h_sei_j_kg: 2.57e5,
            a_sei_s: 1.667e15,
            ea_sei_j_mol: 1.3508e5,
            h_anode_j_kg: 1.714e6,
            a_anode_s: 2.5e13,
            ea_anode_j_mol: 1.3508e5,
            h_cathode_j_kg: 5.10e5,
            a_cathode_s: 6.67e11,
            ea_cathode_j_mol: 1.396e5,
            separator_melt_c: 165.0,
        }
    }

    pub fn nca() -> Self {
        Self {
            name: "NCA",
            cell_mass_kg: 0.069,
            cp_j_kg_k: 975.0,
            rated_ah: 4.9,
            d_ocv_dt_v_k: -0.00045,
            h_sei_j_kg: 2.57e5,
            a_sei_s: 1.667e15,
            ea_sei_j_mol: 1.34e5,
            h_anode_j_kg: 1.65e6,
            a_anode_s: 2.2e13,
            ea_anode_j_mol: 1.345e5,
            h_cathode_j_kg: 4.85e5,
            a_cathode_s: 8.5e11,
            ea_cathode_j_mol: 1.37e5,
            separator_melt_c: 160.0,
        }
    }

    pub fn lco() -> Self {
        Self {
            name: "LCO",
            cell_mass_kg: 0.056,
            cp_j_kg_k: 990.0,
            rated_ah: 4.2,
            d_ocv_dt_v_k: -0.00038,
            h_sei_j_kg: 2.57e5,
            a_sei_s: 1.667e15,
            ea_sei_j_mol: 1.3508e5,
            h_anode_j_kg: 1.55e6,
            a_anode_s: 2.0e13,
            ea_anode_j_mol: 1.35e5,
            h_cathode_j_kg: 3.14e5,
            a_cathode_s: 6.67e11,
            ea_cathode_j_mol: 1.396e5,
            separator_melt_c: 155.0,
        }
    }

    pub fn lfp() -> Self {
        Self {
            name: "LFP",
            cell_mass_kg: 0.088,
            cp_j_kg_k: 1050.0,
            rated_ah: 3.2,
            d_ocv_dt_v_k: -0.00018,
            h_sei_j_kg: 1.80e5,
            a_sei_s: 8.0e14,
            ea_sei_j_mol: 1.38e5,
            h_anode_j_kg: 6.20e5,
            a_anode_s: 6.5e12,
            ea_anode_j_mol: 1.42e5,
            h_cathode_j_kg: 6.80e4,
            a_cathode_s: 1.8e10,
            ea_cathode_j_mol: 1.58e5,
            separator_melt_c: 170.0,
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub struct RunawayStep {
    pub time_s: f64,
    pub temp_c: f64,
    pub dt_dt_c_per_min: f64,
    pub q_gen_watts: f64,
    pub q_cool_watts: f64,
    pub c_sei: f64,
    pub c_anode: f64,
    pub alpha_cathode: f64,
}

/// Bernardi reversible + irreversible thermal power (Watts).
pub fn calculate_bernardi_heat_watts(
    kinetics: &ChemistryKinetics,
    temp_c: f64,
    c_rate: f64,
    dcir_mohm: f64,
) -> f64 {
    let i_amps = c_rate * kinetics.rated_ah;
    let t_k = temp_c + 273.15;
    // Electrolyte conductivity increases slightly with temp up to 60C
    let r_ohm = (dcir_mohm / 1000.0) * (298.15 / t_k.max(250.0)).powf(0.45);
    let q_joule = i_amps * i_amps * r_ohm;
    let q_entropic = -i_amps * t_k * kinetics.d_ocv_dt_v_k;
    (q_joule + q_entropic).max(0.0)
}

fn exothermic_power_and_rates(
    kinetics: &ChemistryKinetics,
    temp_c: f64,
    c_sei: f64,
    c_anode: f64,
    alpha_cathode: f64,
    r_short_ohm: f64,
) -> (f64, f64, f64, f64) {
    let t_k = (temp_c + 273.15).max(200.0);

    let dc_sei = if temp_c > 65.0 && c_sei > 1e-5 {
        -kinetics.a_sei_s * (-kinetics.ea_sei_j_mol / (R_GAS * t_k)).exp() * c_sei
    } else {
        0.0
    };

    let dc_anode = if temp_c > 95.0 && c_anode > 1e-5 {
        -kinetics.a_anode_s * (-kinetics.ea_anode_j_mol / (R_GAS * t_k)).exp() * c_anode
    } else {
        0.0
    };

    let d_alpha_cat = if temp_c > 145.0 && alpha_cathode < 0.9999 {
        kinetics.a_cathode_s
            * (-kinetics.ea_cathode_j_mol / (R_GAS * t_k)).exp()
            * alpha_cathode.max(0.01)
            * (1.0 - alpha_cathode)
    } else {
        0.0
    };

    // Active mass fractions of cell (anode ~18%, cathode ~32%, SEI ~10%)
    let q_sei = -dc_sei * kinetics.cell_mass_kg * 0.10 * kinetics.h_sei_j_kg;
    let q_anode = -dc_anode * kinetics.cell_mass_kg * 0.18 * kinetics.h_anode_j_kg;
    let q_cathode = d_alpha_cat * kinetics.cell_mass_kg * 0.32 * kinetics.h_cathode_j_kg;

    // Internal short circuit triggered when separator collapses or active dendrite micro-short
    let q_short = if r_short_ohm > 0.01 && (temp_c >= kinetics.separator_melt_c || r_short_ohm <= 1.2) {
        let v_cell = 3.85;
        let r_eff = if temp_c >= kinetics.separator_melt_c { r_short_ohm } else { r_short_ohm * 1.6 };
        (v_cell * v_cell) / r_eff
    } else {
        0.0
    };

    (q_sei + q_anode + q_cathode + q_short, dc_sei, dc_anode, d_alpha_cat)
}

/// Finds Semenov Critical Temperature T_crit (degC) where dQ_gen/dT >= hA.
pub fn find_semenov_critical_temperature(
    kinetics: &ChemistryKinetics,
    t_amb_c: f64,
    c_rate: f64,
    dcir_mohm: f64,
    h_conv_w_k: f64,
) -> f64 {
    let mut t = t_amb_c.max(25.0);
    while t <= 320.0 {
        let (q1, _, _, _) = exothermic_power_and_rates(kinetics, t, 0.15, 0.75, 0.04, 0.8);
        let (q2, _, _, _) = exothermic_power_and_rates(kinetics, t + 1.0, 0.15, 0.75, 0.04, 0.8);
        let qb1 = calculate_bernardi_heat_watts(kinetics, t, c_rate, dcir_mohm);
        let qb2 = calculate_bernardi_heat_watts(kinetics, t + 1.0, c_rate, dcir_mohm);
        let dq_dt = (q2 + qb2) - (q1 + qb1);
        if dq_dt >= h_conv_w_k && (q1 + qb1) > h_conv_w_k * (t - t_amb_c) {
            return t;
        }
        t += 1.0;
    }
    300.0
}

/// 4th-order Runge-Kutta integration of coupled thermal runaway state [T, c_sei, c_anode, alpha_cat].
pub fn integrate_runaway_rk4(
    kinetics: &ChemistryKinetics,
    t_init_c: f64,
    t_amb_c: f64,
    c_rate: f64,
    dcir_mohm: f64,
    h_conv_w_k: f64,
    r_short_ohm: f64,
    total_time_s: f64,
    dt_s: f64,
) -> Vec<RunawayStep> {
    let steps = (total_time_s / dt_s).ceil() as usize;
    let mut out = Vec::with_capacity(steps.min(2000));

    let mut t_c = t_init_c;
    let mut c_sei = 0.15_f64;
    let mut c_anode = 0.75_f64;
    let mut alpha_cat = 0.04_f64;
    let cap_j_k = kinetics.cell_mass_kg * kinetics.cp_j_kg_k;

    for i in 0..=steps {
        let time_s = i as f64 * dt_s;
        let (q_exo, dc_s, dc_a, da_c) =
            exothermic_power_and_rates(kinetics, t_c, c_sei, c_anode, alpha_cat, r_short_ohm);
        let q_bern = calculate_bernardi_heat_watts(kinetics, t_c, c_rate, dcir_mohm);
        let q_gen = q_exo + q_bern;
        let q_cool = h_conv_w_k * (t_c - t_amb_c);
        let dt_dt_s = (q_gen - q_cool) / cap_j_k;

        out.push(RunawayStep {
            time_s,
            temp_c: t_c,
            dt_dt_c_per_min: dt_dt_s * 60.0,
            q_gen_watts: q_gen,
            q_cool_watts: q_cool,
            c_sei,
            c_anode,
            alpha_cathode: alpha_cat,
        });

        if t_c >= 750.0 {
            break;
        }

        // RK4 step (sub-stepped for stiffness above 130C)
        let sub = if t_c > 130.0 { 30 } else { 4 };
        let h = dt_s / sub as f64;
        for _ in 0..sub {
            let deriv = |tc: f64, cs: f64, ca: f64, ac: f64| -> (f64, f64, f64, f64) {
                let (qx, ds, da, dc) = exothermic_power_and_rates(kinetics, tc, cs, ca, ac, r_short_ohm);
                let qb = calculate_bernardi_heat_watts(kinetics, tc, c_rate, dcir_mohm);
                let qc = h_conv_w_k * (tc - t_amb_c);
                ((qx + qb - qc) / cap_j_k, ds, da, dc)
            };

            let (k1t, k1s, k1a, k1c) = deriv(t_c, c_sei, c_anode, alpha_cat);
            let (k2t, k2s, k2a, k2c) = deriv(
                (t_c + 0.5 * h * k1t).min(800.0),
                (c_sei + 0.5 * h * k1s).clamp(0.0, 1.0),
                (c_anode + 0.5 * h * k1a).clamp(0.0, 1.0),
                (alpha_cat + 0.5 * h * k1c).clamp(0.0, 1.0),
            );
            let (k3t, k3s, k3a, k3c) = deriv(
                (t_c + 0.5 * h * k2t).min(800.0),
                (c_sei + 0.5 * h * k2s).clamp(0.0, 1.0),
                (c_anode + 0.5 * h * k2a).clamp(0.0, 1.0),
                (alpha_cat + 0.5 * h * k2c).clamp(0.0, 1.0),
            );
            let (k4t, k4s, k4a, k4c) = deriv(
                (t_c + h * k3t).min(800.0),
                (c_sei + h * k3s).clamp(0.0, 1.0),
                (c_anode + h * k3a).clamp(0.0, 1.0),
                (alpha_cat + h * k3c).clamp(0.0, 1.0),
            );

            t_c = (t_c + (h / 6.0) * (k1t + 2.0 * k2t + 2.0 * k3t + k4t)).min(780.0);
            c_sei = (c_sei + (h / 6.0) * (k1s + 2.0 * k2s + 2.0 * k3s + k4s)).clamp(0.0, 1.0);
            c_anode = (c_anode + (h / 6.0) * (k1a + 2.0 * k2a + 2.0 * k3a + k4a)).clamp(0.0, 1.0);
            alpha_cat = (alpha_cat + (h / 6.0) * (k1c + 2.0 * k2c + 2.0 * k3c + k4c)).clamp(0.0, 1.0);
            if t_c >= 780.0 {
                break;
            }
        }
        let _ = (dc_s, dc_a, da_c);
    }
    out
}

/// Computes maximum safe non-plating charge rate (C-rate) vs temperature and SOC
/// using Arrhenius solid-state Li+ diffusivity in graphite.
pub fn plating_safe_charge_c_rate(temp_c: f64, soc_pct: f64) -> f64 {
    let t_k = (temp_c + 273.15).max(230.0);
    let arrhenius_diff = (-36500.0 / R_GAS * (1.0 / t_k - 1.0 / 298.15)).exp();
    let soc_penalty = (1.0 - (soc_pct / 115.0).powi(2)).clamp(0.18, 1.0);
    (2.4 * arrhenius_diff * soc_penalty).clamp(0.04, 3.2)
}
