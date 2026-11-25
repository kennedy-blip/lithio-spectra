#version 300 es
precision highp float;

out vec4 fragColor;

uniform vec2 u_resolution;
uniform float u_time;
uniform float u_current_norm;   // -1.0 (charge) to +1.0 (heavy discharge)
uniform float u_soc_norm;       // 0.0 to 1.0
uniform float u_temp_norm;      // 0.0 (20C) to 1.0 (220C thermal stress)
uniform float u_theme_mode;     // 0=obsidian, 1=daylight, 2=thermal, 3=eco
uniform vec2 u_pointer;         // Normalized pointer [0,1]

float hash21(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
}

// Hexagonal graphite / layered oxide crystal lattice distance
float hexDist(vec2 p) {
    p = abs(p);
    float c = dot(p, normalize(vec2(1.0, 1.7320508)));
    return max(c, p.x);
}

vec4 hexCoords(vec2 uv) {
    vec2 r = vec2(1.0, 1.7320508);
    vec2 h = r * 0.5;
    vec2 a = mod(uv, r) - h;
    vec2 b = mod(uv - h, r) - h;
    vec2 gv = dot(a, a) < dot(b, b) ? a : b;
    float d = 0.5 - hexDist(gv);
    vec2 id = uv - gv;
    return vec4(gv.x, gv.y, d, hash21(id));
}

void main() {
    vec2 uv = (gl_FragCoord.xy - 0.5 * u_resolution) / min(u_resolution.x, u_resolution.y);
    vec2 p_uv = gl_FragCoord.xy / u_resolution;

    // Intercalation drift velocity proportional to battery current
    float flow_dir = sign(u_current_norm + 0.001) * (0.22 + abs(u_current_norm) * 1.15);
    vec2 lattice_uv = uv * 5.2 + vec2(u_time * 0.04 * flow_dir, sin(uv.x * 2.5 + u_time * 0.25) * 0.14);

    vec4 hx = hexCoords(lattice_uv);
    float hex_edge = smoothstep(0.03, 0.08, hx.z);
    float ion_pulse = 0.5 + 0.5 * sin(u_time * (1.8 + abs(u_current_norm) * 4.0) + hx.w * 12.56 + uv.x * 4.0);

    // Butler-Volmer equipotential wave across separator boundary (center x=0)
    float sep_zone = exp(-pow(uv.x * 3.8, 2.0));
    float equipotential = sin(uv.x * 18.0 - u_time * flow_dir * 2.8 + sin(uv.y * 6.0) * 0.6);
    float eq_line = smoothstep(0.92, 0.99, abs(equipotential));

    // Li+ migrating ion particles
    vec2 ion_grid = vec2(uv.x * 10.0 - u_time * flow_dir * 1.4, uv.y * 7.5 + sin(uv.x * 3.0 + hx.w) * 0.35);
    vec2 ion_cell = fract(ion_grid) - 0.5;
    float ion_id = hash21(floor(ion_grid));
    float ion_orb = smoothstep(0.18, 0.03, length(ion_cell)) * step(0.42 - u_soc_norm * 0.25, ion_id);

    // Pointer refraction glow
    float ptr_glow = exp(-length(p_uv - u_pointer) * 3.6);

    vec3 bg_base = vec3(0.015, 0.031, 0.071);
    vec3 col_anode = vec3(0.06, 0.72, 0.51);     // LiFePO4 Emerald
    vec3 col_cathode = vec3(0.22, 0.74, 0.97);   // Cathode Cyan
    vec3 col_thermal = vec3(0.96, 0.25, 0.37);   // Exothermic Crimson

    if (u_theme_mode > 0.5 && u_theme_mode < 1.5) {
        // Daylight Frost
        bg_base = vec3(0.93, 0.95, 0.98);
        col_anode = vec3(0.02, 0.52, 0.39);
        col_cathode = vec3(0.05, 0.45, 0.78);
    } else if (u_theme_mode >= 1.5 && u_theme_mode < 2.5) {
        // Semenov Thermal Infrared
        bg_base = vec3(0.045, 0.012, 0.018);
        col_anode = vec3(0.96, 0.62, 0.04);
        col_cathode = vec3(0.96, 0.24, 0.36);
    }

    vec3 electrode_tint = mix(col_anode, col_cathode, smoothstep(-0.35, 0.35, uv.x));
    electrode_tint = mix(electrode_tint, col_thermal, clamp(u_temp_norm, 0.0, 1.0) * 0.85);

    vec3 color = bg_base;
    if (u_theme_mode > 0.5 && u_theme_mode < 1.5) {
        color -= (1.0 - hex_edge) * 0.055 * (1.0 - electrode_tint);
        color = mix(color, electrode_tint, eq_line * 0.14 + ion_orb * 0.26 + sep_zone * 0.08);
        color += ptr_glow * 0.04 * col_cathode;
    } else {
        color += (1.0 - hex_edge) * electrode_tint * (0.09 + 0.06 * ion_pulse);
        color += eq_line * electrode_tint * 0.16;
        color += ion_orb * mix(col_cathode, vec3(0.85, 0.98, 1.0), 0.55) * 0.55;
        color += sep_zone * electrode_tint * 0.11;
        color += ptr_glow * electrode_tint * 0.16;
    }

    fragColor = vec4(color, 1.0);
}
