package com.lithiospectra.plugins;

import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.hardware.camera2.CameraManager;
import android.os.BatteryManager;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * NativeBatteryTelemetryLoadPlugin
 *
 * Queries Android BatteryManager at 20 Hz for real-time microampere current
 * (BATTERY_PROPERTY_CURRENT_NOW), millivolt terminal voltage (EXTRA_VOLTAGE),
 * temperature (EXTRA_TEMPERATURE), coulomb counter (BATTERY_PROPERTY_CHARGE_COUNTER),
 * and Android 14+ cycle count (EXTRA_CYCLE_COUNT), while executing a controlled
 * multi-threaded CPU + Torch hardware load step (delta I) to extract true DCIR (mOhm).
 */
@CapacitorPlugin(name = "NativeBatteryTelemetryLoad")
public class NativeBatteryTelemetryLoadPlugin extends Plugin {

    private final AtomicBoolean loadRunning = new AtomicBoolean(false);

    @PluginMethod
    public void getBatterySnapshot(PluginCall call) {
        JSObject snap = readSnapshotInternal();
        call.resolve(snap);
    }

    @PluginMethod
    public void runControlledDcirLoadStep(PluginCall call) {
        if (!loadRunning.compareAndSet(false, true)) {
            call.reject("A controlled DCIR load pulse is already in progress.");
            return;
        }

        int durationMs = call.getInt("durationMs", 3000);
        final int clampedMs = Math.max(1200, Math.min(8000, durationMs));
        final boolean useTorch = call.getBoolean("useTorch", true);

        final List<JSObject> samples = new ArrayList<>();
        final long startMs = System.currentTimeMillis();
        final Handler handler = new Handler(Looper.getMainLooper());

        // Capture resting baseline first (0 - 400 ms)
        final JSObject baseline = readSnapshotInternal();
        samples.add(tagSample(baseline, 0.0, "REST"));

        // Start deterministic CPU load threads after 400ms baseline window
        final AtomicBoolean keepBurning = new AtomicBoolean(false);
        final List<Thread> workers = new ArrayList<>();

        Runnable startLoad = () -> {
            keepBurning.set(true);
            int cores = Math.max(2, Math.min(8, Runtime.getRuntime().availableProcessors()));
            for (int c = 0; c < cores; c++) {
                Thread t = new Thread(() -> {
                    double acc = 1.0001;
                    while (keepBurning.get()) {
                        for (int i = 0; i < 40000; i++) {
                            acc = Math.sin(acc) * Math.cos(acc + 0.001) + Math.sqrt(Math.abs(acc) + 1.0);
                        }
                    }
                }, "LithioDcirPulse-" + c);
                t.setPriority(Thread.MAX_PRIORITY);
                t.start();
                workers.add(t);
            }
            if (useTorch) {
                setTorchState(true);
            }
        };

        Runnable stopLoadAndFinish = () -> {
            keepBurning.set(false);
            if (useTorch) {
                setTorchState(false);
            }
            for (Thread t : workers) {
                try {
                    t.join(150);
                } catch (InterruptedException ignored) {
                }
            }

            JSObject result = computeDcirSummary(baseline, samples);
            loadRunning.set(false);
            call.resolve(result);
        };

        // Sample at 20 Hz (every 50 ms)
        final Runnable sampler = new Runnable() {
            @Override
            public void run() {
                long elapsed = System.currentTimeMillis() - startMs;
                String phase = elapsed < 450 ? "REST" : (elapsed < clampedMs - 600 ? "LOAD_PULSE" : "RECOVERY");
                samples.add(tagSample(readSnapshotInternal(), elapsed / 1000.0, phase));

                if (elapsed < clampedMs) {
                    handler.postDelayed(this, 50);
                } else {
                    stopLoadAndFinish.run();
                }
            }
        };

        handler.postDelayed(startLoad, 450);
        handler.postDelayed(() -> {
            keepBurning.set(false);
            if (useTorch) setTorchState(false);
        }, clampedMs - 600);
        handler.postDelayed(sampler, 50);
    }

    private JSObject readSnapshotInternal() {
        Context ctx = getContext();
        BatteryManager bm = (BatteryManager) ctx.getSystemService(Context.BATTERY_SERVICE);
        IntentFilter filter = new IntentFilter(Intent.ACTION_BATTERY_CHANGED);
        Intent intent = ctx.registerReceiver(null, filter);

        int currentNowUa = bm != null ? bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CURRENT_NOW) : 0;
        int currentAvgUa = bm != null ? bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CURRENT_AVERAGE) : 0;
        int chargeCounterUah = bm != null ? bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CHARGE_COUNTER) : 0;
        long energyNwh = bm != null ? bm.getLongProperty(BatteryManager.BATTERY_PROPERTY_ENERGY_COUNTER) : 0L;
        int socPct = bm != null ? bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY) : -1;

        int voltageMv = intent != null ? intent.getIntExtra(BatteryManager.EXTRA_VOLTAGE, 0) : 0;
        int tempTenthsC = intent != null ? intent.getIntExtra(BatteryManager.EXTRA_TEMPERATURE, 250) : 250;
        int health = intent != null ? intent.getIntExtra(BatteryManager.EXTRA_HEALTH, BatteryManager.BATTERY_HEALTH_UNKNOWN) : 0;
        String tech = intent != null ? intent.getStringExtra(BatteryManager.EXTRA_TECHNOLOGY) : "Li-ion";
        int cycleCount = -1;
        if (Build.VERSION.SDK_INT >= 34 && intent != null) {
            cycleCount = intent.getIntExtra("android.os.extra.CYCLE_COUNT", -1);
        }

        JSObject obj = new JSObject();
        obj.put("currentNowMa", currentNowUa / 1000.0);
        obj.put("currentAvgMa", currentAvgUa / 1000.0);
        obj.put("chargeCounterMah", chargeCounterUah / 1000.0);
        obj.put("energyMwh", energyNwh / 1_000_000.0);
        obj.put("socPct", socPct);
        obj.put("voltageMv", voltageMv);
        obj.put("temperatureC", tempTenthsC / 10.0);
        obj.put("healthCode", health);
        obj.put("technology", tech != null ? tech : "Li-ion");
        obj.put("cycleCount", cycleCount);
        obj.put("timestampMs", System.currentTimeMillis());
        return obj;
    }

    private JSObject tagSample(JSObject snap, double timeS, String phase) {
        snap.put("timeS", Math.round(timeS * 1000.0) / 1000.0);
        snap.put("phase", phase);
        return snap;
    }

    private JSObject computeDcirSummary(JSObject baseline, List<JSObject> samples) {
        double vRest = baseline.optDouble("voltageMv", 3900.0);
        double iRest = Math.abs(baseline.optDouble("currentNowMa", 180.0));

        double minVLoad = vRest;
        double maxILoad = iRest;
        JSArray arr = new JSArray();
        for (JSObject s : samples) {
            arr.put(s);
            if ("LOAD_PULSE".equals(s.optString("phase"))) {
                double v = s.optDouble("voltageMv", vRest);
                double i = Math.abs(s.optDouble("currentNowMa", iRest));
                if (v > 2500.0 && v < minVLoad) minVLoad = v;
                if (i > maxILoad) maxILoad = i;
            }
        }

        double deltaV = Math.max(0.0, vRest - minVLoad);
        double deltaI = Math.max(50.0, maxILoad - iRest);
        double r0Mohm = deltaV / (deltaI / 1000.0);

        JSObject out = new JSObject();
        out.put("vRestMv", vRest);
        out.put("vLoadMinMv", minVLoad);
        out.put("iRestMa", iRest);
        out.put("iLoadPeakMa", maxILoad);
        out.put("deltaIMa", deltaI);
        out.put("r0OhmicMohm", Math.round(r0Mohm * 100.0) / 100.0);
        out.put("samples", arr);
        return out;
    }

    private void setTorchState(boolean enabled) {
        try {
            CameraManager cm = (CameraManager) getContext().getSystemService(Context.CAMERA_SERVICE);
            if (cm != null && cm.getCameraIdList().length > 0) {
                cm.setTorchMode(cm.getCameraIdList()[0], enabled);
            }
        } catch (Exception ignored) {
        }
    }
}
