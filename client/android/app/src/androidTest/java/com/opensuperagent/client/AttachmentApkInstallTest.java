package com.opensuperagent.client;

import static org.junit.Assert.*;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.view.accessibility.AccessibilityNodeInfo;
import androidx.activity.result.ActivityResult;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import com.getcapacitor.JSObject;
import com.getcapacitor.PluginCall;
import java.io.File;
import java.lang.reflect.Method;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.util.Arrays;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;

/** Disposable .distributiontest only; run it against both distributions.
 * A build whose merged manifest lacks REQUEST_INSTALL_PACKAGES (Google Play)
 * must refuse to hand an APK to an installer on both open routes with a stable
 * error, and must keep saving, sharing and opening ordinary files. The GitHub
 * build keeps Android's per-app consent flow. Nothing is ever installed. */
@RunWith(AndroidJUnit4.class)
public class AttachmentApkInstallTest {
    private static final String SAVER = "OpenSuperAgentAttachmentSaver", OPENER = "OpenSuperAgentAttachmentOpener", KEY = "3".repeat(64);
    private static final String APK = "application/vnd.android.package-archive", UNSUPPORTED = "attachment_install_unsupported", CONSENT = "attachment_install_permission_required";
    private MainActivity activity;
    private static Context target() { return InstrumentationRegistry.getInstrumentation().getTargetContext(); }
    /** The merged manifest, not a compiled-in constant, decides which behaviour this install owes. */
    private static boolean installCapable() throws Exception {
        String[] requested = target().getPackageManager().getPackageInfo(target().getPackageName(), PackageManager.GET_PERMISSIONS).requestedPermissions;
        return requested != null && Arrays.asList(requested).contains("android.permission.REQUEST_INSTALL_PACKAGES");
    }
    private String js(String code) throws Exception {
        var instrument = InstrumentationRegistry.getInstrumentation(); var result = new AtomicReference<String>(); var done = new CountDownLatch(1);
        instrument.runOnMainSync(() -> activity.getBridge().getWebView().evaluateJavascript(code, value -> { result.set(value); done.countDown(); }));
        assertTrue(done.await(10, TimeUnit.SECONDS)); return result.get();
    }
    private void launch() throws Exception {
        var instrument = InstrumentationRegistry.getInstrumentation();
        assertTrue("Disposable app only", target().getPackageName().endsWith(".distributiontest"));
        activity = (MainActivity) instrument.startActivitySync(new Intent(target(), MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK));
        long until = System.currentTimeMillis() + 30000;
        while (!"true".equals(js("!!window.Capacitor?.nativePromise")) && System.currentTimeMillis() < until) Thread.sleep(100);
        assertEquals("true", js("!!window.Capacitor?.nativePromise"));
    }
    private void send(String plugin, String method, JSONObject args) throws Exception {
        js("window.distributionResult=null;Capacitor.nativePromise(" + JSONObject.quote(plugin) + "," + JSONObject.quote(method) + "," + args + ").then(r=>window.distributionResult={ok:true,...r},e=>window.distributionResult={error:e.message})");
    }
    private JSONObject result() throws Exception {
        long until = System.currentTimeMillis() + 15000;
        while ("null".equals(js("window.distributionResult")) && System.currentTimeMillis() < until) Thread.sleep(100);
        return new JSONObject(js("window.distributionResult"));
    }
    private JSONObject call(String plugin, String method, JSONObject args) throws Exception { send(plugin, method, args); return result(); }
    private static JSONObject uri(Object value) throws Exception { return new JSONObject().put("uri", value.toString()); }
    private static File export(String name, byte[] bytes) throws Exception {
        File folder = new File(target().getCacheDir(), "open-super-agent-exports/123-abc-def"); folder.mkdirs();
        File file = new File(folder, name); Files.write(file.toPath(), bytes); return file;
    }
    /** A real, parseable APK, so an installer that is reached has something to show. */
    private static File exportApk(String name) throws Exception {
        File file = export(name, new byte[0]);
        Files.copy(new File(InstrumentationRegistry.getInstrumentation().getContext().getPackageCodePath()).toPath(), file.toPath(), StandardCopyOption.REPLACE_EXISTING);
        return file;
    }
    /** Package of the active window. A first launch may not report one yet, so wait for it. */
    private static String foreground() throws Exception {
        long until = System.currentTimeMillis() + 5000;
        while (true) {
            var root = InstrumentationRegistry.getInstrumentation().getUiAutomation().getRootInActiveWindow();
            if (root != null && root.getPackageName() != null) return root.getPackageName().toString();
            if (System.currentTimeMillis() > until) return "";
            Thread.sleep(100);
        }
    }
    private static void assertNothingLaunched() throws Exception {
        Thread.sleep(600); // An activity start would have replaced the App window by now.
        assertEquals("No installer, chooser or Settings page may open", target().getPackageName(), foreground());
    }
    private static boolean leftApp() throws Exception {
        long until = System.currentTimeMillis() + 10000;
        while (foreground().equals(target().getPackageName()) && System.currentTimeMillis() < until) Thread.sleep(100);
        return !foreground().isEmpty() && !foreground().equals(target().getPackageName());
    }
    private static void backToApp() throws Exception {
        var automation = InstrumentationRegistry.getInstrumentation().getUiAutomation();
        for (int i = 0; i < 4 && !foreground().equals(target().getPackageName()); i++) { automation.performGlobalAction(android.accessibilityservice.AccessibilityService.GLOBAL_ACTION_BACK); Thread.sleep(700); }
    }
    private boolean find(String text, boolean click) { return findNode(InstrumentationRegistry.getInstrumentation().getUiAutomation().getRootInActiveWindow(), text, click); }
    private boolean findNode(AccessibilityNodeInfo node, String text, boolean click) {
        if (node == null) return false;
        if (node.getText() != null && node.getText().toString().toLowerCase(java.util.Locale.ROOT).contains(text.toLowerCase(java.util.Locale.ROOT))) {
            if (!click) return true;
            for (AccessibilityNodeInfo item = node; item != null; item = item.getParent()) if (item.isClickable() && item.performAction(AccessibilityNodeInfo.ACTION_CLICK)) return true;
        }
        for (int i = 0; i < node.getChildCount(); i++) if (findNode(node.getChild(i), text, click)) return true;
        return false;
    }
    private boolean readerShows(String bytes) throws Exception {
        long until = System.currentTimeMillis() + 15000; String expected = "reader:" + bytes + ":content:true";
        while (!find(expected, false) && System.currentTimeMillis() < until) { find("Open Super Agent Reader Probe", true); find("Just once", true); Thread.sleep(100); }
        return find(expected, false);
    }
    /** The Settings callback and the launch step are private; reach each boundary directly. */
    private String boundary(String name, Uri saved) throws Exception {
        Object plugin = activity.getBridge().getPlugin(SAVER).getInstance(); var outcome = new AtomicReference<String>(); var done = new CountDownLatch(1);
        PluginCall call = new PluginCall(null, SAVER, "distribution", "openSaved", new JSObject().put("uri", saved.toString())) {
            @Override public void resolve() { outcome.set("launched"); done.countDown(); }
            @Override public void reject(String message) { outcome.set(message); done.countDown(); }
        };
        boolean callback = name.equals("installPermissionReturned");
        Method method = callback ? plugin.getClass().getDeclaredMethod(name, PluginCall.class, ActivityResult.class) : plugin.getClass().getDeclaredMethod(name, PluginCall.class);
        method.setAccessible(true);
        if (callback) method.invoke(plugin, call, null); else method.invoke(plugin, call);
        assertTrue(name + " must settle its call", done.await(10, TimeUnit.SECONDS)); return outcome.get();
    }
    @Test public void savedApkReachesAnInstallerOnlyWhereThisBuildMayInstall() throws Exception {
        launch(); var context = target(); File apk = exportApk("distribution-saved.apk"); byte[] bytes = Files.readAllBytes(apk.toPath()); Uri saved = null;
        try {
            var receipt = call(SAVER, "save", uri(apk.toURI()).put("mime", "application/octet-stream").put("key", KEY));
            assertTrue(receipt.toString(), receipt.getBoolean("saved")); saved = Uri.parse(receipt.getString("uri"));
            assertEquals(APK, context.getContentResolver().getType(saved));
            try (var input = context.getContentResolver().openInputStream(saved)) { assertNotNull(input); assertArrayEquals("Saving an APK stays exact in every build", bytes, input.readAllBytes()); }
            if (installCapable()) {
                assertFalse("Fresh disposable install has no install consent", context.getPackageManager().canRequestPackageInstalls());
                send(SAVER, "openSaved", uri(saved)); assertTrue("Android's per-app install setting opens", leftApp());
                backToApp(); assertEquals(CONSENT, result().getString("error"));
                return;
            }
            assertEquals(UNSUPPORTED, call(SAVER, "openSaved", uri(saved)).getString("error")); assertNothingLaunched();
            // A receipt restored after the Activity is recreated grants the same refusal, not an install.
            InstrumentationRegistry.getInstrumentation().runOnMainSync(activity::finish); InstrumentationRegistry.getInstrumentation().waitForIdleSync(); launch();
            assertEquals("attachment_saved_uri_invalid", call(SAVER, "openSaved", uri(saved)).getString("error"));
            var restored = call(SAVER, "getSaved", new JSONObject().put("key", KEY)); assertTrue(restored.toString(), restored.getBoolean("saved"));
            assertEquals(UNSUPPORTED, call(SAVER, "openSaved", uri(saved)).getString("error")); assertNothingLaunched();
        } finally {
            if (saved != null) context.getContentResolver().delete(saved, null, null);
            context.getSharedPreferences("open_super_agent_saved_attachments_v1", Context.MODE_PRIVATE).edit().remove(KEY).commit();
            apk.delete(); InstrumentationRegistry.getInstrumentation().runOnMainSync(activity::finish);
        }
    }
    @Test public void savedApkCallbackAndLaunchBoundariesHoldTheSameLine() throws Exception {
        launch(); var context = target(); File apk = exportApk("distribution-boundary.apk"); Uri saved = null;
        try {
            var receipt = call(SAVER, "save", uri(apk.toURI()).put("mime", "application/octet-stream"));
            assertTrue(receipt.toString(), receipt.getBoolean("saved")); saved = Uri.parse(receipt.getString("uri"));
            // A plugin recreated while Settings was open no longer remembers the save; the callback still answers for an APK.
            Uri forgotten = Uri.parse("content://media/external/downloads/999999999");
            if (installCapable()) { assertEquals("Returning from Settings without consent", CONSENT, boundary("installPermissionReturned", forgotten)); return; }
            assertEquals(UNSUPPORTED, boundary("installPermissionReturned", forgotten)); assertEquals(UNSUPPORTED, boundary("installPermissionReturned", saved));
            assertEquals(UNSUPPORTED, boundary("launchSaved", saved)); assertNothingLaunched();
        } finally {
            backToApp(); if (saved != null) context.getContentResolver().delete(saved, null, null);
            apk.delete(); InstrumentationRegistry.getInstrumentation().runOnMainSync(activity::finish);
        }
    }
    @Test public void externalApkOpenReachesAChooserOnlyWhereThisBuildMayInstall() throws Exception {
        launch(); File apk = exportApk("distribution-external.apk"), untyped = exportApk("distribution-external.open-super-agentapk");
        try {
            var named = call(OPENER, "open", uri(apk.toURI()).put("mime", "application/octet-stream").put("title", "Open with"));
            if (installCapable()) { assertTrue(named.toString(), named.getBoolean("ok")); assertTrue("Android takes over the APK", leftApp()); return; }
            assertEquals(named.toString(), UNSUPPORTED, named.optString("error")); assertNothingLaunched();
            // No known extension: the caller's APK type must not become a second route.
            assertEquals(UNSUPPORTED, call(OPENER, "open", uri(untyped.toURI()).put("mime", APK).put("title", "Open with")).getString("error")); assertNothingLaunched();
        } finally { backToApp(); apk.delete(); untyped.delete(); InstrumentationRegistry.getInstrumentation().runOnMainSync(activity::finish); }
    }
    @Test public void everyBuildStillSharesApksAndOpensOrdinaryFiles() throws Exception {
        launch(); var context = target(); Uri saved = null;
        File sheet = export("distribution-saved.xlsx", "saved-original".getBytes(StandardCharsets.UTF_8)), other = export("distribution-external.xlsx", "external-original".getBytes(StandardCharsets.UTF_8)), apk = exportApk("distribution-share.apk");
        try {
            var receipt = call(SAVER, "save", uri(sheet.toURI()).put("mime", "application/octet-stream"));
            assertTrue(receipt.toString(), receipt.getBoolean("saved")); saved = Uri.parse(receipt.getString("uri"));
            assertTrue(call(SAVER, "openSaved", uri(saved)).getBoolean("ok")); assertTrue("Saved ordinary file opens in a reader", readerShows("saved-original")); backToApp();
            assertTrue(call(OPENER, "open", uri(other.toURI()).put("mime", "application/octet-stream").put("title", "Choose reader")).getBoolean("ok"));
            assertTrue("Ordinary file opens in another app", readerShows("external-original")); backToApp();
            send("Share", "share", new JSONObject().put("title", apk.getName()).put("files", new org.json.JSONArray().put(apk.toURI().toString())));
            assertTrue("Sharing an APK still reaches Android's share sheet", leftApp()); backToApp();
            assertEquals("true", js("!!window.Capacitor?.nativePromise"));
        } finally {
            backToApp(); if (saved != null) context.getContentResolver().delete(saved, null, null);
            sheet.delete(); other.delete(); apk.delete(); InstrumentationRegistry.getInstrumentation().runOnMainSync(activity::finish);
        }
    }
}
