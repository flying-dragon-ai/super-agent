package com.opensuperagent.client;

import static org.junit.Assert.*;
import android.content.Context;
import android.content.ContextWrapper;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.File;
import java.lang.reflect.Proxy;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;

/** Disposable .distributiontest only: this seeds and removes the updater's own
 * vault entry, offer and cache files. A Play install that replaces a GitHub APK
 * must drop that leftover state without decrypting the credential and must
 * stay disabled even when the cleanup fails. No network is used. */
@RunWith(AndroidJUnit4.class)
public class AndroidUpdaterDistributionTest {
    private static final String TOKEN = "distribution_only_secret_0123456789", ENTRY = "com.opensuperagent.native-identity.v1.android-updates-github";
    private MainActivity activity;
    private static Context target() { return InstrumentationRegistry.getInstrumentation().getTargetContext(); }
    private static File updates(Context context) { return new File(context.getCacheDir(), "open-super-agent-updates"); }
    private static SharedPreferences offers() { return target().getSharedPreferences("open_super_agent_android_updates_v1", Context.MODE_PRIVATE); }
    private static SharedPreferences vault() { return target().getSharedPreferences("OpenSuperAgentNativeIdentityV1", Context.MODE_PRIVATE); }
    private static void seed(boolean credential, boolean offer) throws Exception {
        if (credential) new DeviceKeyStore(target()).write("android-updates-github", new JSONObject().put("token", TOKEN).put("login", "probe-user").toString());
        if (offer) assertTrue(offers().edit().putString("offer", new JSONObject().put("version", "9.9.9").put("assetId", 1).put("url", "https://api.github.com/repos/owner/repo/releases/assets/1")
            .put("size", 5).put("sha256", "0".repeat(64)).put("notes", "n").toString()).commit());
        assertTrue(updates(target()).isDirectory() || updates(target()).mkdirs());
        Files.write(new File(updates(target()), "update.apk").toPath(), "hello".getBytes(StandardCharsets.UTF_8));
        Files.write(new File(updates(target()), "update.part").toPath(), "part".getBytes(StandardCharsets.UTF_8));
    }
    private static void assertRetired() {
        assertFalse("Updater credential is gone", vault().contains(ENTRY)); assertNull("Offer is gone", offers().getString("offer", null));
        assertFalse("Verified APK is gone", new File(updates(target()), "update.apk").exists()); assertFalse("Partial download is gone", new File(updates(target()), "update.part").exists());
    }
    private static void assertDisabled(JSONObject state) throws Exception {
        assertEquals(state.toString(), "disabled", state.getString("phase")); assertFalse(state.getBoolean("inAppUpdates")); assertFalse(state.getBoolean("configured"));
        assertFalse("A Play build holds no GitHub session", state.getBoolean("authenticated")); assertFalse(state.has("login")); assertFalse(state.has("nextVersion")); assertFalse(state.has("error"));
    }
    private static AndroidUpdateService play(Context context, List<String> events) { return new AndroidUpdateService(context, "owner/repo", "Ov23.testing", value -> events.add(value.toString()), false); }
    private static boolean disposable() { return target().getPackageName().endsWith(".distributiontest"); }
    @Before public void disposableOnly() { assertTrue("Disposable app only", disposable()); clean(); }
    /** JUnit runs this even when the guard above fails, so it repeats the guard:
     * a real install's updater credential, offer and downloads are never touched. */
    @After public void clean() {
        if (!disposable()) return;
        try { new DeviceKeyStore(target()).remove("android-updates-github", false); } catch (Exception ignored) { /* Nothing was stored. */ }
        try { new DeviceKeyStore(target()).remove("distribution-neighbour", false); } catch (Exception ignored) { /* Nothing was stored. */ }
        offers().edit().remove("offer").remove("distribution-neighbour").commit(); new File(updates(target()), "update.apk").delete(); new File(updates(target()), "update.part").delete();
    }
    @Test public void playLoadRetiresGitHubStateWithoutReadingTheCredential() throws Exception {
        List<String> events = new ArrayList<>(); seed(true, true);
        // Neighbours in the same vault and preference file belong to pairing and other features.
        new DeviceKeyStore(target()).write("distribution-neighbour", "kept"); assertTrue(offers().edit().putString("distribution-neighbour", "kept").commit());
        AndroidUpdateService service = play(target(), events); service.load();
        assertDisabled(service.snapshot()); assertRetired(); assertEquals(1, events.size()); assertDisabled(new JSONObject(events.get(0)));
        assertEquals("Only the updater's own vault entry is removed", "kept", new DeviceKeyStore(target()).read("distribution-neighbour", false));
        assertEquals("Only the offer is removed from the updater preferences", "kept", offers().getString("distribution-neighbour", null));
        for (String event : events) { assertFalse(event.contains(TOKEN)); assertFalse(event.contains("probe-user")); }
        service.check(); assertDisabled(service.snapshot());
        assertEquals("github_update_unsupported", assertThrows(java.io.IOException.class, service::startLogin).getMessage());
        // A download killed before verification leaves files but no offer record.
        seed(false, false); play(target(), events).load(); assertRetired();
        // An entry that cannot be decrypted proves the credential is removed, never read.
        assertTrue(vault().edit().putString(ENTRY, "not-a-wrapped-secret").commit());
        AndroidUpdateService unreadable = play(target(), events); unreadable.load(); assertDisabled(unreadable.snapshot()); assertRetired();
    }
    @Test public void playLoadStaysDisabledWhenCleanupFails() throws Exception {
        seed(true, true);
        File cache = new File(target().getCacheDir(), "distribution-stuck"), apk = new File(cache, "open-super-agent-updates/update.apk"), part = new File(cache, "open-super-agent-updates/update.part");
        assertTrue(new File(apk, "kept").mkdirs()); assertTrue(new File(part, "kept").mkdirs()); // Non-empty directories cannot be deleted as files.
        Context stuck = new ContextWrapper(target()) {
            @Override public File getCacheDir() { return cache; }
            @Override public SharedPreferences getSharedPreferences(String name, int mode) {
                SharedPreferences real = super.getSharedPreferences(name, mode);
                Object editor = Proxy.newProxyInstance(SharedPreferences.Editor.class.getClassLoader(), new Class<?>[]{SharedPreferences.Editor.class},
                    (self, method, args) -> method.getName().equals("commit") ? (Object) false : method.getReturnType() == SharedPreferences.Editor.class ? self : null);
                return (SharedPreferences) Proxy.newProxyInstance(SharedPreferences.class.getClassLoader(), new Class<?>[]{SharedPreferences.class},
                    (self, method, args) -> method.getName().equals("edit") ? editor : method.invoke(real, args));
            }
        };
        try {
            List<String> events = new ArrayList<>(); AndroidUpdateService service = play(stuck, events);
            service.load(); assertDisabled(service.snapshot()); service.load(); service.check(); assertDisabled(service.snapshot());
            for (String event : events) { assertDisabled(new JSONObject(event)); assertFalse(event.contains(TOKEN)); }
            assertTrue("The failure was real: nothing could be removed", vault().contains(ENTRY) && offers().getString("offer", null) != null && apk.isDirectory() && part.isDirectory());
            assertEquals("github_update_unsupported", assertThrows(java.io.IOException.class, service::download).getMessage());
        } finally { for (File file : new File[]{new File(apk, "kept"), apk, new File(part, "kept"), part, apk.getParentFile(), cache}) file.delete(); }
    }
    @Test public void gitHubLoadKeepsItsSessionAndOffer() throws Exception {
        seed(true, false); Files.delete(new File(updates(target()), "update.apk").toPath());
        String offer = new JSONObject().put("version", "9.9.9").put("assetId", 1).put("url", "https://api.github.com/repos/owner/repo/releases/assets/1").put("size", 5).put("sha256", "0".repeat(64)).put("notes", "n").toString();
        assertTrue(offers().edit().putString("offer", offer).commit());
        AndroidUpdateService service = new AndroidUpdateService(target(), "owner/repo", "Ov23.testing", value -> { }, true); service.load();
        JSONObject state = service.snapshot();
        assertEquals(state.toString(), "initial", state.getString("phase")); assertTrue(state.getBoolean("inAppUpdates")); assertTrue(state.getBoolean("authenticated"));
        assertEquals("probe-user", state.getString("login")); assertEquals("9.9.9", state.getString("nextVersion"));
        assertTrue(vault().contains(ENTRY)); assertEquals(offer, offers().getString("offer", null)); assertTrue(new File(updates(target()), "update.part").isFile());
    }
    private String js(String code) throws Exception {
        var instrument = InstrumentationRegistry.getInstrumentation(); var result = new AtomicReference<String>(); var done = new CountDownLatch(1);
        instrument.runOnMainSync(() -> activity.getBridge().getWebView().evaluateJavascript(code, value -> { result.set(value); done.countDown(); }));
        assertTrue(done.await(10, TimeUnit.SECONDS)); return result.get();
    }
    @Test public void bridgeStatusFollowsThisBuildsDistribution() throws Exception {
        String[] requested = target().getPackageManager().getPackageInfo(target().getPackageName(), PackageManager.GET_PERMISSIONS).requestedPermissions;
        boolean gitHub = requested != null && Arrays.asList(requested).contains("android.permission.REQUEST_INSTALL_PACKAGES");
        seed(true, true); var instrument = InstrumentationRegistry.getInstrumentation();
        activity = (MainActivity) instrument.startActivitySync(new Intent(target(), MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK));
        try {
            long until = System.currentTimeMillis() + 30000;
            while (!"true".equals(js("!!window.Capacitor?.nativePromise")) && System.currentTimeMillis() < until) Thread.sleep(100);
            js("window.distributionStatus=null;Capacitor.nativePromise('OpenSuperAgentAndroidUpdater','status',{}).then(r=>window.distributionStatus={ok:true,...r},e=>window.distributionStatus={error:e.message})");
            until = System.currentTimeMillis() + 15000;
            while ("null".equals(js("window.distributionStatus")) && System.currentTimeMillis() < until) Thread.sleep(100);
            JSONObject status = new JSONObject(js("window.distributionStatus")); assertTrue(status.toString(), status.optBoolean("ok"));
            assertEquals("The status flag is the App's only APK-install signal", gitHub, status.getBoolean("inAppUpdates"));
            if (gitHub) { assertTrue(status.getBoolean("authenticated")); assertEquals("probe-user", status.getString("login")); assertTrue(vault().contains(ENTRY)); }
            else { assertDisabled(status); assertRetired(); }
            assertFalse(status.toString().contains(TOKEN));
        } finally { instrument.runOnMainSync(activity::finish); }
    }
}
