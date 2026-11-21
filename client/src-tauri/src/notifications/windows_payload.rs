use super::state::{Notice, Target};

pub const APP_ID: &str = "com.opensuperagent.client";

/// Notification activation is distinct from ordinary conversation links. The
/// native inbox owns it; the frontend deep-link listener must not dispatch it too.
pub fn activation_url(target: &Target) -> Result<String, String> {
    target.validate()?;
    Ok(format!("opensuperagent://notification/{}?message={}&host={}", target.conversation_id, target.message_id, target.host_id))
}
pub fn activation_target(raw: &str) -> Option<Target> {
    if raw.len() > 512 { return None; }
    let raw = raw.strip_prefix("opensuperagent://notification/")?;
    let (conversation, query) = raw.split_once('?')?;
    let mut message = None; let mut host = None;
    for item in query.split('&') {
        let (key, value) = item.split_once('=')?;
        match key {
            "message" if message.is_none() => message = Some(value),
            "host" if host.is_none() => host = Some(value),
            _ => return None,
        }
    }
    let target = Target { host_id: host?.into(), conversation_id: conversation.into(), message_id: message?.into() };
    target.validate().ok()?; Some(target)
}
pub fn activation_args(args: &[String]) -> Option<Target> {
    if args.len() != 2 { return None; }
    activation_target(&args[1])
}
/// The registration confirmation only focuses the window: it names no Host,
/// conversation or message and never enters the native Inbox.
pub const READY_URL: &str = "opensuperagent://notification/ready";
pub const CONFIRMATION_TAG: &str = "ready";
/// Host groups are 64 hex characters, so this group cannot collide with one.
pub const CONFIRMATION_GROUP: &str = "app";
/// Used only if an older renderer sends no localized confirmation text.
pub const DEFAULT_CONFIRMATION: &str = "通知已开启。Notifications are on.";
pub fn ready_activation(args: &[String]) -> bool { args.len() == 2 && args[1] == READY_URL }

fn xml_text(value: &str) -> String {
    let mut escaped = String::new();
    for ch in value.chars() {
        match ch {
            '&' => escaped.push_str("&amp;"), '<' => escaped.push_str("&lt;"), '>' => escaped.push_str("&gt;"),
            '"' => escaped.push_str("&quot;"), '\'' => escaped.push_str("&apos;"),
            '\t' | '\n' | '\r' => escaped.push(ch),
            // XML 1.0 rejects controls and these non-characters.
            ch if ch >= ' ' && ch != '\u{fffe}' && ch != '\u{ffff}' => escaped.push(ch),
            _ => escaped.push('\u{fffd}'),
        }
    }
    escaped
}
pub fn toast_xml(notice: &Notice) -> Result<String, String> {
    notice.validate()?;
    // No <audio> element: Windows plays its default notification sound.
    let (title, body) = notice.display();
    Ok(format!("<toast activationType=\"protocol\" launch=\"{}\"><visual><binding template=\"ToastGeneric\"><text>{}</text><text>{}</text></binding></visual></toast>",
        xml_text(&activation_url(&notice.target())?), xml_text(&title), xml_text(&body)))
}
/// Visible registration toast. The renderer supplies the localized body.
pub fn confirmation_xml(body: &str) -> Result<String, String> {
    let length = body.encode_utf16().count();
    if length == 0 || length > 200 || body.trim().is_empty() { return Err("invalid_notification".into()); }
    Ok(format!("<toast activationType=\"protocol\" launch=\"{READY_URL}\"><visual><binding template=\"ToastGeneric\"><text>open-super-agent</text><text>{}</text></binding></visual></toast>", xml_text(body)))
}
pub fn host_group(host: &str) -> Result<&str, String> {
    if !super::state::valid_host(host) { return Err("invalid_notification_host".into()); }
    // Windows 10 1703+ allows 64 chars. Preserve all 256 bits of Hub identity.
    Ok(&host[4..])
}

#[cfg(test)]
mod tests {
    use super::*;
    fn notice() -> Notice { serde_json::from_str(include_str!("../../fixtures/desktop-notification.json")).unwrap() }
    #[test]
    fn activation_roundtrip_requires_exact_scoped_notification_args() {
        let target = notice().target(); let url = activation_url(&target).unwrap();
        assert_eq!(activation_args(&["app.exe".into(), url.clone()]), Some(target.clone()));
        for bad in [url.replace("notification/", "conversation/"), url.replace("hub_", "other_"), format!("{url}&message=other"), format!("{url}#fragment"), url.replace("/chat?", "/%2e%2e?")] {
            assert!(activation_target(&bad).is_none(), "{bad}");
        }
        assert!(activation_args(&[url.clone()]).is_none());
        assert!(activation_args(&["app.exe".into(), url, "extra".into()]).is_none());
        assert!(activation_target("opensuperagent://notification/chat?message=message").is_none());
    }
    #[test]
    fn toast_is_escaped_and_only_uses_protocol_activation() {
        let mut notice = notice(); notice.body = "<action arguments=\"evil\"> & 中文\0".into();
        let xml = toast_xml(&notice).unwrap();
        assert!(xml.contains("<text>open-super-agent</text>"));
        assert!(xml.contains("activationType=\"protocol\""));
        assert!(xml.contains("message=message&amp;host=hub_"));
        assert!(xml.contains("&lt;action arguments=&quot;evil&quot;&gt; &amp; 中文�"));
        assert!(!xml.contains("<action ")); assert!(!xml.contains('\0'));
    }
    #[test]
    fn toast_uses_an_escaped_conversation_heading_as_its_title() {
        let mut notice = notice(); notice.body = "「A & <B>」 · CC1\n回复完成：已修复。".into();
        let xml = toast_xml(&notice).unwrap();
        assert!(xml.contains("<text>「A &amp; &lt;B&gt;」 · CC1</text><text>回复完成：已修复。</text>"));
        assert!(!xml.contains("<text>open-super-agent</text>"));
    }
    #[test]
    fn confirmation_toast_is_escaped_bounded_and_only_focuses() {
        let xml = confirmation_xml("通知已开启 <b>&</b>").unwrap();
        assert!(xml.contains("launch=\"opensuperagent://notification/ready\""));
        assert!(xml.contains("<text>open-super-agent</text><text>通知已开启 &lt;b&gt;&amp;&lt;/b&gt;</text>"));
        assert!(!xml.contains("<action") && !xml.contains("<b>"));
        assert!(confirmation_xml(&"字".repeat(200)).is_ok());
        for bad in [String::new(), "  ".into(), "a".repeat(201), "😀".repeat(101)] { assert!(confirmation_xml(&bad).is_err(), "{bad}"); }
        assert!(confirmation_xml(DEFAULT_CONFIRMATION).is_ok());
        // Strict: the confirmation URL is never a routable notification target.
        assert!(activation_target(READY_URL).is_none());
        assert!(ready_activation(&["app.exe".into(), READY_URL.into()]));
        for bad in [format!("{READY_URL}?x=1"), format!("{READY_URL}/"), format!("{READY_URL}#a"), "opensuperagent://notification/Ready".into(), "opensuperagent://conversation/ready".into()] {
            assert!(!ready_activation(&["app.exe".into(), bad.clone()]), "{bad}");
        }
        assert!(!ready_activation(&[READY_URL.into()]));
        assert!(!ready_activation(&["app.exe".into(), READY_URL.into(), "extra".into()]));
        assert_ne!(CONFIRMATION_GROUP.len(), 64);
    }
    #[test]
    fn host_cleanup_groups_keep_full_identity_and_reject_invalid_values() {
        assert_eq!(host_group(&notice().host_id).unwrap(), "a".repeat(64));
        assert!(host_group("hub_short").is_err());
        assert_ne!(host_group(&format!("hub_{}a", "a".repeat(63))).unwrap(), host_group(&format!("hub_{}b", "a".repeat(63))).unwrap());
    }
}
