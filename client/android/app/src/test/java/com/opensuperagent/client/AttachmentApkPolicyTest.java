package com.opensuperagent.client;

import static org.junit.Assert.*;
import org.junit.Test;

public class AttachmentApkPolicyTest {
    private static final String APK = "application/vnd.android.package-archive";
    private static final AttachmentApkPolicy.Grant UNASKED = () -> { throw new AssertionError("Android's install consent must not be consulted"); };
    @Test public void buildsWithoutApkInstallRefuseEveryApkBeforeAskingAndroid() {
        for (String mime : new String[]{APK, "Application/VND.Android.Package-Archive", " " + APK + " "})
            assertEquals(mime, "attachment_install_unsupported", AttachmentApkPolicy.blocked(false, mime, UNASKED));
    }
    @Test public void ordinaryTypesAreNeverGatedInAnyBuild() {
        for (String mime : new String[]{"application/pdf", "application/octet-stream", "application/zip", APK + "x", "application/vnd.android.package", "", null})
            for (boolean apkInstall : new boolean[]{true, false}) assertNull(String.valueOf(mime), AttachmentApkPolicy.blocked(apkInstall, mime, UNASKED));
    }
    @Test public void installCapableBuildsFollowAndroidsPerAppConsent() {
        assertNull(AttachmentApkPolicy.blocked(true, APK, () -> true));
        assertEquals("attachment_install_permission_required", AttachmentApkPolicy.blocked(true, APK, () -> false));
    }
    @Test public void aThrowingConsentCheckBecomesARejectionNotACrash() {
        // PackageManager.canRequestPackageInstalls() throws exactly this when the manifest lacks the permission.
        assertEquals("attachment_install_unsupported", AttachmentApkPolicy.blocked(true, APK, () -> { throw new SecurityException("Need to declare android.permission.REQUEST_INSTALL_PACKAGES to call this api"); }));
        assertEquals("attachment_open_failed", AttachmentApkPolicy.blocked(true, APK, () -> { throw new IllegalStateException("system"); }));
    }
}
