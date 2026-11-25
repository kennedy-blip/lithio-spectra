#version 300 es
precision highp float;

out vec4 fragColor;

uniform vec2 u_resolution;
uniform float u_time;
uniform float u_bulge_mm;       // Simulated or live Z-axis pouch dome deflection (0.0 - 4.5 mm)
uniform float u_fringe_pitch;   // Moire spatial grating density (12 - 48)
uniform float u_phase_shift;    // Optical carrier phase sweep
uniform float u_has_video;      // 1.0 when live camera stream bound, 0.0 when synthetic plate
uniform sampler2D u_video_tex;

void main() {
    vec2 uv = gl_FragCoord.xy / u_resolution;
    vec2 centered = (uv - 0.5) * vec2(u_resolution.x / u_resolution.y, 1.0);

    // Timoshenko clamped-plate dome shape: w(x,y) = w_max * cos^2(pi*x/a) * cos^2(pi*y/b)
    float rx = clamp(centered.x * 1.45, -1.0, 1.0);
    float ry = clamp(centered.y * 1.85, -1.0, 1.0);
    float plate_mask = step(abs(centered.x), 0.68) * step(abs(centered.y), 0.52);
    float dome = pow(cos(rx * 1.570796), 2.0) * pow(cos(ry * 1.570796), 2.0) * plate_mask;
    float z_mm = u_bulge_mm * dome;

    // Specular Moire fringe phase distortion induced by local slope dz/dx
    float phase_deflect = z_mm * 3.85;
    float base_grating = 0.5 + 0.5 * cos(uv.x * u_fringe_pitch * 6.28318 + u_phase_shift);
    float deformed_grating = 0.5 + 0.5 * cos((uv.x + uv.y * 0.08) * u_fringe_pitch * 6.28318 + phase_deflect + u_phase_shift);

    // Beat / Moire interference envelope
    float moire_beat = abs(base_grating - deformed_grating);
    float contour_rings = smoothstep(0.84, 0.98, abs(sin(z_mm * 9.5 - u_time * 0.6)));

    vec3 base_surface = vec3(0.06, 0.09, 0.14);
    if (u_has_video > 0.5) {
        vec2 v_uv = vec2(uv.x, 1.0 - uv.y);
        vec3 cam = texture(u_video_tex, v_uv).rgb;
        float luma = dot(cam, vec3(0.299, 0.587, 0.114));
        // Overlay real-time optical zebra grating onto specular reflection
        float cam_moire = abs(luma - deformed_grating);
        base_surface = mix(cam, vec3(cam_moire), 0.55);
    } else {
        // Synthetic brushed aluminum-laminate LiPo pouch surface
        float foil_grain = 0.92 + 0.08 * sin(uv.y * 280.0) * cos(uv.x * 90.0);
        base_surface = vec3(0.14, 0.17, 0.22) * foil_grain * (0.45 + 0.55 * plate_mask);
        // Pouch crimp borders
        float crimp = smoothstep(0.65, 0.68, abs(centered.x)) + smoothstep(0.49, 0.52, abs(centered.y));
        base_surface += clamp(crimp, 0.0, 1.0) * vec3(0.05, 0.06, 0.08);
    }

    // False-color elevation heatmap blend (Cyan flat -> Amber early gas -> Crimson spicy pillow)
    vec3 heat_col = mix(
        vec3(0.06, 0.72, 0.51),
        mix(vec3(0.96, 0.62, 0.04), vec3(0.96, 0.25, 0.37), smoothstep(0.8, 2.6, z_mm)),
        smoothstep(0.08, 0.9, z_mm)
    );

    vec3 fringe_overlay = mix(vec3(0.88, 0.96, 1.0), heat_col, clamp(z_mm / 1.8, 0.0, 1.0));
    vec3 final_col = mix(base_surface, fringe_overlay, 0.38 * deformed_grating + 0.35 * moire_beat);
    final_col += contour_rings * heat_col * 0.48 * step(0.12, u_bulge_mm);

    // Optical reticle crosshairs
    float cross_x = smoothstep(0.0028, 0.0, abs(centered.x)) * step(abs(centered.y), 0.12);
    float cross_y = smoothstep(0.0028, 0.0, abs(centered.y)) * step(abs(centered.x), 0.12);
    final_col += (cross_x + cross_y) * vec3(0.22, 0.74, 0.97) * 0.65;

    fragColor = vec4(final_col, 1.0);
}
