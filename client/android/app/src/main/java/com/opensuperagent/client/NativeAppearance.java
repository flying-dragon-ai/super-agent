package com.opensuperagent.client;

import android.app.Activity;
import android.content.Context;
import android.content.res.Configuration;
import android.graphics.Color;
import android.graphics.drawable.ColorDrawable;
import android.view.View;
import android.view.ViewGroup;
import androidx.activity.ComponentActivity;
import androidx.activity.EdgeToEdge;
import androidx.activity.SystemBarStyle;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;

/** The WebView is inset inside decor padding. Paint that padding with the same
 * canvas as the web app; theme-color alone cannot paint native system areas. */
final class NativeAppearance {
    // A full-screen reader paints its own dark canvas over the saved theme.
    // Never persisted: a new page or Activity has no reader and starts clean.
    private static Integer readerColor;
    private static boolean readerDarkIcons;
    private static boolean immersive;

    static void restore(ComponentActivity activity) {
        var prefs = activity.getSharedPreferences("appearance", Context.MODE_PRIVATE);
        int color = readerColor != null ? readerColor : prefs.getInt("background", Color.WHITE);
        apply(activity, color, readerColor != null ? readerDarkIcons : prefs.getBoolean("darkIcons", true));
        // Focus and resume can reveal hidden bars; re-hide them while the reader asks.
        if (immersive) hideBars(activity);
    }
    static void save(ComponentActivity activity, int color, boolean darkIcons) {
        activity.getSharedPreferences("appearance", Context.MODE_PRIVATE).edit()
            .putInt("background", color).putBoolean("darkIcons", darkIcons).apply();
        restore(activity);
    }
    static void setReader(ComponentActivity activity, Integer color, boolean darkIcons) {
        readerColor = color; readerDarkIcons = darkIcons;
        restore(activity);
    }
    static void setImmersive(ComponentActivity activity, boolean value) {
        if (immersive == value) { restore(activity); return; }
        immersive = value;
        if (value) {
            // The WebView grows into the hidden bars; the reader re-anchors on resize.
            NativeInsets.setImmersive(activity, true);
            hideBars(activity);
        } else {
            var window = activity.getWindow();
            WindowCompat.getInsetsController(window, window.getDecorView()).show(WindowInsetsCompat.Type.systemBars());
            NativeInsets.setImmersive(activity, false);
        }
    }
    /** A reloaded page or recreated Activity cannot release an older reader. */
    static void resetReader(ComponentActivity activity) {
        readerColor = null;
        if (immersive) setImmersive(activity, false);
        restore(activity);
    }
    private static void hideBars(Activity activity) {
        var window = activity.getWindow();
        var controller = WindowCompat.getInsetsController(window, window.getDecorView());
        controller.setSystemBarsBehavior(WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
        controller.hide(WindowInsetsCompat.Type.systemBars());
    }
    private static void apply(ComponentActivity activity, int color, boolean darkIcons) {
        var window = activity.getWindow();
        window.setBackgroundDrawable(new ColorDrawable(color));
        window.getDecorView().setBackgroundColor(color);
        // Transparent bars over that canvas on every Android version. A fixed
        // light or dark style follows the app theme rather than the system one,
        // and adds no OS contrast scrim behind three-button navigation.
        var style = darkIcons ? SystemBarStyle.light(Color.TRANSPARENT, Color.TRANSPARENT) : SystemBarStyle.dark(Color.TRANSPARENT);
        EdgeToEdge.enable(activity, style, style);
        followConfiguration(activity);
        // DecorView's background update can clear the padding owned by
        // NativeInsets. Restore it synchronously, before the next layout/paint.
        NativeInsets.restorePadding(activity);
    }
    /** EdgeToEdge keeps a hidden DecorView child that replays the style of its
     * first call on every configuration change, after the Activity callback.
     * A later sibling restores the current canvas within that same dispatch. */
    private static void followConfiguration(ComponentActivity activity) {
        var decor = (ViewGroup) activity.getWindow().getDecorView();
        for (int index = decor.getChildCount() - 1; index >= 0; index--) if (decor.getChildAt(index) instanceof Follower) return;
        decor.addView(new Follower(activity));
    }
    private static final class Follower extends View {
        private final ComponentActivity activity;
        Follower(ComponentActivity activity) { super(activity); this.activity = activity; setVisibility(GONE); setWillNotDraw(true); }
        @Override protected void onConfigurationChanged(Configuration newConfig) { restore(activity); }
    }
}
