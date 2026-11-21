package com.opensuperagent.client;

/** One decision for every route that could hand an APK to Android's installer.
 * A build without APK install (Google Play) refuses before asking Android
 * anything. Saving or sharing an APK and all other types are never gated. */
final class AttachmentApkPolicy {
    static final String MIME = "application/vnd.android.package-archive";
    static final String UNSUPPORTED = "attachment_install_unsupported", CONSENT_REQUIRED = "attachment_install_permission_required";
    /** Android's per-app "install unknown apps" consent. */
    interface Grant { boolean granted(); }
    static boolean apk(String mime) { return mime != null && MIME.equalsIgnoreCase(mime.trim()); }
    /** Null when the open may proceed, otherwise the rejection code. */
    static String blocked(boolean apkInstall, String mime, Grant grant) {
        if (!apk(mime)) return null;
        if (!apkInstall) return UNSUPPORTED;
        try { return grant.granted() ? null : CONSENT_REQUIRED; }
        // Android throws instead of answering when the manifest lacks
        // REQUEST_INSTALL_PACKAGES; that build cannot install either.
        catch (SecurityException undeclared) { return UNSUPPORTED; }
        catch (RuntimeException failure) { return "attachment_open_failed"; }
    }
}
