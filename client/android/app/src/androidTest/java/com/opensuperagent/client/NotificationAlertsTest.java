package com.opensuperagent.client;

import static org.junit.Assert.*;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.Context;
import android.app.Notification;
import android.media.AudioAttributes;
import android.provider.Settings;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.util.Map;
import java.nio.charset.StandardCharsets;
import org.json.JSONObject;
import org.unifiedpush.android.connector.data.PushMessage;
import org.junit.Test;
import org.junit.runner.RunWith;

/** Run each method after a clean install of the disposable notificationtest app. */
@RunWith(AndroidJUnit4.class)
public class NotificationAlertsTest {
    private Context context() {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        assertTrue("Disposable app only", context.getPackageName().endsWith(".notificationtest"));
        return context;
    }
    private void show(Context context) {
        OpenSuperAgentNotifications.show(context, Map.of("id", "alert-probe", "conversationId", "chat-probe", "messageId", "message-probe", "kind", "answer"));
    }
    @Test public void freshNotificationEnablesSoundAndVibration() {
        Context context = context();
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        assertNull("Requires clean disposable installation", manager.getNotificationChannel("open-super-agent"));
        show(context);
        NotificationChannel channel = manager.getNotificationChannel("open-super-agent");
        assertNotNull(channel);
        assertEquals(NotificationManager.IMPORTANCE_HIGH, channel.getImportance());
        assertEquals(Settings.System.DEFAULT_NOTIFICATION_URI, channel.getSound());
        assertEquals(AudioAttributes.USAGE_NOTIFICATION, channel.getAudioAttributes().getUsage());
        assertTrue("New message notifications must request vibration", channel.shouldVibrate());
        assertArrayEquals(new long[] { 0, 200 }, channel.getVibrationPattern());
        assertTrue(MessageNotificationChannel.status(context).optBoolean("soundEnabled"));
        assertTrue(MessageNotificationChannel.status(context).optBoolean("vibrationEnabled"));
        assertEquals(1, manager.getActiveNotifications().length);
        assertTrue((manager.getActiveNotifications()[0].getNotification().flags & Notification.FLAG_ONLY_ALERT_ONCE) != 0);
        show(context);
        assertEquals("A redelivery updates the same notification", 1, manager.getActiveNotifications().length);
        manager.cancelAll();
    }
    @Test public void existingSilentChannelKeepsItsSettings() {
        Context context = context();
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        assertNull("Requires clean disposable installation", manager.getNotificationChannel("open-super-agent"));
        NotificationChannel old = new NotificationChannel("open-super-agent", "Open Super Agent", NotificationManager.IMPORTANCE_LOW);
        old.setSound(null, null);
        old.enableVibration(false);
        manager.createNotificationChannel(old);
        show(context);
        NotificationChannel channel = manager.getNotificationChannel("open-super-agent");
        assertEquals(NotificationManager.IMPORTANCE_LOW, channel.getImportance());
        assertNull(channel.getSound());
        assertFalse(channel.shouldVibrate());
        assertFalse(MessageNotificationChannel.status(context).optBoolean("soundEnabled"));
        assertFalse(MessageNotificationChannel.status(context).optBoolean("vibrationEnabled"));
        var settings = MessageNotificationChannel.settingsIntent(context);
        assertEquals(Settings.ACTION_CHANNEL_NOTIFICATION_SETTINGS, settings.getAction());
        assertEquals("open-super-agent", settings.getStringExtra(Settings.EXTRA_CHANNEL_ID));
        assertEquals(context.getPackageName(), settings.getStringExtra(Settings.EXTRA_APP_PACKAGE));
        assertEquals("Do not create a new channel to bypass user preferences", 1, manager.getNotificationChannels().size());
        manager.cancelAll();
    }
    @Test public void checkingOrOpeningSettingsDoesNotCreateChannel() {
        Context context = context();
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        assertNull("Requires clean disposable installation", manager.getNotificationChannel("open-super-agent"));
        var status = MessageNotificationChannel.status(context);
        assertEquals("missing", status.optString("channel"));
        assertFalse(status.has("soundEnabled"));
        assertFalse(status.has("vibrationEnabled"));
        var settings = MessageNotificationChannel.settingsIntent(context);
        assertEquals(Settings.ACTION_APP_NOTIFICATION_SETTINGS, settings.getAction());
        assertEquals(context.getPackageName(), settings.getStringExtra(Settings.EXTRA_APP_PACKAGE));
        OpenSuperAgentNotifications.show(context, Map.of("id", "invalid payload"));
        assertNull(manager.getNotificationChannel("open-super-agent"));
        assertEquals(0, manager.getActiveNotifications().length);
    }
    @Test public void richReplyShowsConversationAndResultWithARedactedLockScreenVersion() {
        Context context = context();
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        manager.cancelAll();
        String host = "hub_" + "a".repeat(64);
        var reply = Map.of("id", "preview-probe", "conversationId", "preview-chat", "messageId", "preview-message", "hostId", host,
            "kind", "answer", "body", "「ADHD 体验」 · CC1\n回复完成：已修复侧栏宽度，保留对话草稿。");
        OpenSuperAgentNotifications.show(context, reply);
        var active = manager.getActiveNotifications();
        assertEquals(1, active.length);
        assertEquals(host + ":preview-probe", active[0].getTag());
        Notification notification = active[0].getNotification();
        assertEquals("「ADHD 体验」 · CC1", notification.extras.getCharSequence(Notification.EXTRA_TITLE).toString());
        assertEquals("回复完成：已修复侧栏宽度，保留对话草稿。", notification.extras.getCharSequence(Notification.EXTRA_TEXT).toString());
        assertEquals(notification.extras.getCharSequence(Notification.EXTRA_TEXT).toString(), notification.extras.getCharSequence(Notification.EXTRA_BIG_TEXT).toString());
        assertEquals(Notification.VISIBILITY_PRIVATE, notification.visibility);
        assertNotNull(notification.contentIntent);
        assertNotNull(notification.publicVersion);
        assertEquals("Open Super Agent", notification.publicVersion.extras.getCharSequence(Notification.EXTRA_TITLE).toString());
        assertFalse(notification.publicVersion.extras.getCharSequence(Notification.EXTRA_TEXT).toString().contains("草稿"));
        OpenSuperAgentNotifications.show(context, reply);
        assertEquals(1, manager.getActiveNotifications().length);
        assertTrue((manager.getActiveNotifications()[0].getNotification().flags & Notification.FLAG_ONLY_ALERT_ONCE) != 0);
        manager.cancelAll();
    }
    @Test public void unifiedPushKeepsPreviewAndRejectsOtherOrRemovedHosts() throws Exception {
        Context context = context();
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        manager.cancelAll();
        String host = "hub_" + "b".repeat(64), other = "hub_" + "c".repeat(64);
        UnifiedPushRegistry registry = UnifiedPushPlugin.store(context);
        String key = UnifiedPushRegistry.instance(host, "preview-device");
        String registration = registry.prepare(key, host, "preview-device", false, "test.distributor").getString("registrationId");
        class Receiver extends OpenSuperAgentUnifiedPushService {
            void attach(Context context) { attachBaseContext(context); }
        }
        Receiver receiver = new Receiver(); receiver.attach(context);
        JSONObject data = new JSONObject().put("id", "up-preview").put("conversationId", "preview-chat")
            .put("messageId", "preview-message").put("hostId", host).put("kind", "answer")
            .put("body", "「备用线路」 · CC1\n回复完成：已完成代码审阅。");
        try {
            receiver.onMessage(new PushMessage(data.toString().getBytes(StandardCharsets.UTF_8), true), registration);
            var active = manager.getActiveNotifications(); assertEquals(1, active.length);
            assertEquals(host + ":up-preview", active[0].getTag());
            assertEquals("「备用线路」 · CC1", active[0].getNotification().extras.getCharSequence(Notification.EXTRA_TITLE).toString());
            assertEquals("回复完成：已完成代码审阅。", active[0].getNotification().extras.getCharSequence(Notification.EXTRA_TEXT).toString());
            manager.cancelAll(); data.put("hostId", other);
            receiver.onMessage(new PushMessage(data.toString().getBytes(StandardCharsets.UTF_8), true), registration);
            assertEquals(0, manager.getActiveNotifications().length);
            data.put("hostId", host); registry.beginRemoval(key, true);
            receiver.onMessage(new PushMessage(data.toString().getBytes(StandardCharsets.UTF_8), true), registration);
            assertEquals(0, manager.getActiveNotifications().length);
        } finally { manager.cancelAll(); registry.beginRemoval(key, true); registry.finishRemoval(key, registration); }
    }
}
