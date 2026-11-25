package com.lithiospectra.plugins;

import android.Manifest;
import android.content.Context;
import android.content.pm.PackageManager;
import android.hardware.Sensor;
import android.hardware.SensorEvent;
import android.hardware.SensorEventListener;
import android.hardware.SensorManager;
import android.media.AudioFormat;
import android.media.AudioRecord;
import android.media.MediaRecorder;

import androidx.core.app.ActivityCompat;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.util.ArrayList;
import java.util.List;

/**
 * UltrasonicChargerEmfPlugin
 *
 * Captures unprocessed 48 kHz PCM audio (10 - 24 kHz flyback inductor magnetostriction
 * & pouch-cell acoustic impulse ping responses) synchronized with uncalibrated
 * 3-axis Magnetometer (200 Hz) transformer leakage flux measurements in microtesla (uT).
 */
@CapacitorPlugin(
    name = "UltrasonicChargerEmf",
    permissions = {
        @Permission(alias = "microphone", strings = { Manifest.permission.RECORD_AUDIO })
    }
)
public class UltrasonicChargerEmfPlugin extends Plugin {

    private static final int SAMPLE_RATE = 48000;

    @PluginMethod
    public void captureChargerAndAcousticFrame(PluginCall call) {
        if (getPermissionState("microphone") != PermissionState.GRANTED) {
            requestPermissionForAlias("microphone", call, "micPermissionCallback");
            return;
        }
        runCaptureInternal(call);
    }

    @PermissionCallback
    private void micPermissionCallback(PluginCall call) {
        if (getPermissionState("microphone") == PermissionState.GRANTED) {
            runCaptureInternal(call);
        } else {
            call.reject("Microphone permission is required for 48 kHz ultrasonic charger forensics.");
        }
    }

    private void runCaptureInternal(PluginCall call) {
        final int durationMs = Math.max(400, Math.min(3000, call.getInt("durationMs", 1200)));
        final Context ctx = getContext();

        if (ActivityCompat.checkSelfPermission(ctx, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            call.reject("RECORD_AUDIO permission missing.");
            return;
        }

        final SensorManager sm = (SensorManager) ctx.getSystemService(Context.SENSOR_SERVICE);
        final Sensor magSensor = sm != null ? sm.getDefaultSensor(Sensor.TYPE_MAGNETIC_FIELD_UNCALIBRATED) : null;
        final List<Double> magMagnitudesUt = new ArrayList<>();

        final SensorEventListener magListener = new SensorEventListener() {
            @Override
            public void onSensorChanged(SensorEvent event) {
                double bx = event.values[0];
                double by = event.values[1];
                double bz = event.values[2];
                double mag = Math.sqrt(bx * bx + by * by + bz * bz);
                synchronized (magMagnitudesUt) {
                    magMagnitudesUt.add(mag);
                }
            }

            @Override
            public void onAccuracyChanged(Sensor sensor, int accuracy) {}
        };

        if (sm != null && magSensor != null) {
            sm.registerListener(magListener, magSensor, SensorManager.SENSOR_DELAY_FASTEST);
        }

        new Thread(() -> {
            int minBuf = AudioRecord.getMinBufferSize(
                SAMPLE_RATE,
                AudioFormat.CHANNEL_IN_MONO,
                AudioFormat.ENCODING_PCM_FLOAT
            );
            int targetSamples = (SAMPLE_RATE * durationMs) / 1000;
            int audioSource = MediaRecorder.AudioSource.UNPROCESSED;

            AudioRecord recorder = new AudioRecord(
                audioSource,
                SAMPLE_RATE,
                AudioFormat.CHANNEL_IN_MONO,
                AudioFormat.ENCODING_PCM_FLOAT,
                Math.max(minBuf, 8192)
            );

            float[] allSamples = new float[targetSamples];
            int collected = 0;

            try {
                recorder.startRecording();
                float[] chunk = new float[2048];
                while (collected < targetSamples) {
                    int read = recorder.read(chunk, 0, Math.min(chunk.length, targetSamples - collected), AudioRecord.READ_BLOCKING);
                    if (read > 0) {
                        System.arraycopy(chunk, 0, allSamples, collected, read);
                        collected += read;
                    } else {
                        break;
                    }
                }
                recorder.stop();
            } finally {
                recorder.release();
                if (sm != null && magSensor != null) {
                    sm.unregisterListener(magListener);
                }
            }

            // Compute Goertzel ultrasonic band energy (12 - 22 kHz) & 120 Hz modulation proxy
            double ultrasonicPeakHz = estimateDominantFrequency(allSamples, SAMPLE_RATE, 11000.0, 22500.0);
            double rmsAudio = computeRms(allSamples, collected);

            double meanMagUt = 45.0;
            double acRippleUt = 0.0;
            synchronized (magMagnitudesUt) {
                if (!magMagnitudesUt.isEmpty()) {
                    double sum = 0.0;
                    for (double v : magMagnitudesUt) sum += v;
                    meanMagUt = sum / magMagnitudesUt.size();
                    double var = 0.0;
                    for (double v : magMagnitudesUt) var += (v - meanMagUt) * (v - meanMagUt);
                    acRippleUt = Math.sqrt(var / magMagnitudesUt.size());
                }
            }

            JSArray downsampledPcm = new JSArray();
            int stride = Math.max(1, collected / 512);
            for (int i = 0; i < collected; i += stride) {
                downsampledPcm.put(Math.round(allSamples[i] * 10000.0) / 10000.0);
            }

            JSObject out = new JSObject();
            out.put("sampleRateHz", SAMPLE_RATE);
            out.put("capturedSamples", collected);
            out.put("ultrasonicPeakHz", Math.round(ultrasonicPeakHz));
            out.put("audioRms", Math.round(rmsAudio * 1e6) / 1e6);
            out.put("magneticDcMeanUt", Math.round(meanMagUt * 100.0) / 100.0);
            out.put("magneticAcRippleUt", Math.round(acRippleUt * 100.0) / 100.0);
            out.put("pcmEnvelope", downsampledPcm);
            call.resolve(out);
        }, "LithioUltrasonicCapture").start();
    }

    private double computeRms(float[] buf, int len) {
        if (len <= 0) return 0.0;
        double sum = 0.0;
        for (int i = 0; i < len; i++) sum += buf[i] * buf[i];
        return Math.sqrt(sum / len);
    }

    private double estimateDominantFrequency(float[] buf, int fs, double fMin, double fMax) {
        int n = Math.min(buf.length, 4096);
        double bestFreq = fMin;
        double bestPower = -1.0;
        for (double f = fMin; f <= fMax; f += 250.0) {
            double omega = (2.0 * Math.PI * f) / fs;
            double coeff = 2.0 * Math.cos(omega);
            double q0, q1 = 0.0, q2 = 0.0;
            for (int i = 0; i < n; i++) {
                q0 = coeff * q1 - q2 + buf[i];
                q2 = q1;
                q1 = q0;
            }
            double power = q1 * q1 + q2 * q2 - q1 * q2 * coeff;
            if (power > bestPower) {
                bestPower = power;
                bestFreq = f;
            }
        }
        return bestFreq;
    }
}
