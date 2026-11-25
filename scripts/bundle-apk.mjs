import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const distDir = path.join(rootDir, 'dist');
const publicReleasesDir = path.join(rootDir, 'public', 'releases');
const distReleasesDir = path.join(distDir, 'releases');

const APK_FILENAME = 'lithio-spectra-v1.24.0-universal.apk';
const MANIFEST_FILENAME = 'apk-manifest.json';

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function walkDir(dir, base = dir) {
  const results = [];
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'releases') continue;
      results.push(...walkDir(full, base));
    } else {
      results.push({
        rel: path.relative(base, full).replace(/\\/g, '/'),
        full
      });
    }
  }
  return results;
}

function buildZipArchive(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const item of entries) {
    const nameBytes = Buffer.from(item.name, 'utf8');
    const data = Buffer.isBuffer(item.data) ? item.data : Buffer.from(item.data, 'utf8');
    const crc = crc32(data);

    const lh = Buffer.alloc(30 + nameBytes.length);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0, 6);
    lh.writeUInt16LE(0, 8); // STORE (ZIP-aligned uncompressed asset access)
    lh.writeUInt16LE(0, 10);
    lh.writeUInt16LE(0, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nameBytes.length, 26);
    lh.writeUInt16LE(0, 28);
    nameBytes.copy(lh, 30);

    localParts.push(lh, data);

    const ch = Buffer.alloc(46 + nameBytes.length);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0, 8);
    ch.writeUInt16LE(0, 10);
    ch.writeUInt16LE(0, 12);
    ch.writeUInt16LE(0, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(data.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(nameBytes.length, 28);
    ch.writeUInt16LE(0, 30);
    ch.writeUInt16LE(0, 32);
    ch.writeUInt16LE(0, 34);
    ch.writeUInt16LE(0, 36);
    ch.writeUInt32LE(0, 38);
    ch.writeUInt32LE(offset, 42);
    nameBytes.copy(ch, 46);
    centralParts.push(ch);

    offset += lh.length + data.length;
  }

  const centralBuf = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralBuf, eocd]);
}

function main() {
  if (!fs.existsSync(distDir)) {
    throw new Error('dist/ not found. Run vite build first.');
  }

  fs.mkdirSync(publicReleasesDir, { recursive: true });
  fs.mkdirSync(distReleasesDir, { recursive: true });

  const entries = [];

  // 1. AndroidManifest.xml
  entries.push({
    name: 'AndroidManifest.xml',
    data: [
      '<?xml version="1.0" encoding="utf-8"?>',
      '<manifest xmlns:android="http://schemas.android.com/apk/res/android"',
      '    package="com.lithiospectra.electrochem"',
      '    android:versionCode="12400"',
      '    android:versionName="1.24.0">',
      '  <uses-sdk android:minSdkVersion="26" android:targetSdkVersion="34" />',
      '  <uses-permission android:name="android.permission.CAMERA" />',
      '  <uses-permission android:name="android.permission.RECORD_AUDIO" />',
      '  <uses-permission android:name="android.permission.FLASHLIGHT" />',
      '  <uses-permission android:name="android.permission.INTERNET" />',
      '  <application android:label="LITHIO-SPECTRA" android:usesCleartextTraffic="false">',
      '    <activity android:name="com.getcapacitor.BridgeActivity" android:exported="true" />',
      '  </application>',
      '</manifest>'
    ].join('\n')
  });

  // 2. Capacitor config
  const capPath = path.join(rootDir, 'capacitor.config.json');
  if (fs.existsSync(capPath)) {
    entries.push({
      name: 'assets/capacitor.config.json',
      data: fs.readFileSync(capPath)
    });
  }

  // 3. Compiled web app bundle inside assets/public/
  const distFiles = walkDir(distDir);
  for (const f of distFiles) {
    entries.push({
      name: `assets/public/${f.rel}`,
      data: fs.readFileSync(f.full)
    });
  }

  // 4. Native Java 17 Capacitor plugin sources
  const javaDir = path.join(rootDir, 'android/app/src/main/java/com/lithiospectra/plugins');
  for (const jf of walkDir(javaDir)) {
    entries.push({
      name: `assets/native-plugins/${jf.rel}`,
      data: fs.readFileSync(jf.full)
    });
  }

  // 5. META-INF/MANIFEST.MF
  const manifestLines = [
    'Manifest-Version: 1.0',
    'Created-By: LITHIO-SPECTRA Release Bundler 1.24.0',
    `Built-At: ${new Date().toISOString()}`,
    `Bundled-Entries: ${entries.length}`,
    ''
  ];
  entries.push({
    name: 'META-INF/MANIFEST.MF',
    data: manifestLines.join('\n')
  });

  const apkBuffer = buildZipArchive(entries);
  const sha256 = crypto.createHash('sha256').update(apkBuffer).digest('hex');

  const publicApkPath = path.join(publicReleasesDir, APK_FILENAME);
  const distApkPath = path.join(distReleasesDir, APK_FILENAME);
  fs.writeFileSync(publicApkPath, apkBuffer);
  fs.writeFileSync(distApkPath, apkBuffer);

  const manifestObj = {
    packageId: 'com.lithiospectra.electrochem',
    version: '1.24.0',
    filename: APK_FILENAME,
    downloadUrl: `/releases/${APK_FILENAME}`,
    sizeBytes: apkBuffer.length,
    sizeKb: Math.round((apkBuffer.length / 1024) * 10) / 10,
    sha256,
    bundledFilesCount: entries.length,
    builtAtUtc: new Date().toISOString(),
    plugins: [
      'NativeBatteryTelemetryLoadPlugin.java',
      'UltrasonicChargerEmfPlugin.java'
    ]
  };

  const manifestJson = JSON.stringify(manifestObj, null, 2);
  fs.writeFileSync(path.join(publicReleasesDir, MANIFEST_FILENAME), manifestJson);
  fs.writeFileSync(path.join(distReleasesDir, MANIFEST_FILENAME), manifestJson);

  console.log(
    `[bundle-apk] Built ${APK_FILENAME} (${manifestObj.sizeKb} KB, ${entries.length} entries, sha256=${sha256.slice(0, 16)}...)`
  );
}

main();
