//! Platform-independent Windows toast status policy. The WinRT call sites live
//! in `windows.rs`; every decision they act on is here so it is unit-tested on
//! any host (`cfg(any(target_os = "windows", test))`).
//!
//! An unpackaged app has no notification profile until it has shown a toast.
//! Before that `ToastNotifier.Setting` fails with ERROR_NOT_FOUND (0x80070490)
//! and Windows Settings does not list the app. That is "not registered yet",
//! never "denied": only an explicit `Disabled*` setting blocks delivery.
use serde::Serialize;
use std::collections::BTreeMap;

/// `HRESULT_FROM_WIN32(ERROR_NOT_FOUND)`.
pub const ERROR_NOT_FOUND: i32 = 0x8007_0490_u32 as i32;
/// `WPN_E_PLATFORM_UNAVAILABLE`: the notification platform is unavailable.
pub const WPN_E_PLATFORM_UNAVAILABLE: i32 = 0x803E_0105_u32 as i32;
/// Bounded re-reads after the confirmation toast: immediately, then up to this
/// many retries spaced by `CONFIRMATION_PAUSE_MS` (under one second in total).
pub const CONFIRMATION_RETRIES: usize = 3;
pub const CONFIRMATION_PAUSE_MS: u64 = 150;

pub fn hresult(code: i32) -> String { format!("0x{:08X}", code as u32) }

/// One `ToastNotifier.Setting` read: `Ok(raw NotificationSetting)` or `Err(HRESULT)`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Status {
    Enabled,
    /// Raw NotificationSetting 1-4: DisabledForApplication, DisabledForUser,
    /// DisabledByGroupPolicy, DisabledByManifest.
    Disabled(i32),
    /// No notification profile yet (ERROR_NOT_FOUND before the first toast).
    Unregistered,
    PlatformUnavailable,
    /// Any other read failure (HRESULT).
    Unreadable(i32),
    /// A NotificationSetting value this build does not know.
    Unknown(i32),
}
pub fn classify(read: Result<i32, i32>) -> Status {
    match read {
        Ok(0) => Status::Enabled,
        Ok(value @ 1..=4) => Status::Disabled(value),
        Ok(value) => Status::Unknown(value),
        Err(ERROR_NOT_FOUND) => Status::Unregistered,
        Err(WPN_E_PLATFORM_UNAVAILABLE) => Status::PlatformUnavailable,
        Err(code) => Status::Unreadable(code),
    }
}
impl Status {
    /// Read-only permission (`permission(false)`): never shows or writes anything.
    /// Change the read policy for an unreadable or unknown setting here.
    pub fn permission(self) -> Result<&'static str, &'static str> {
        match self {
            Status::Enabled => Ok("granted"),
            Status::Disabled(_) => Ok("denied"),
            Status::PlatformUnavailable => Err("native_notification_platform_unavailable"),
            // The system has not refused. An explicit request registers the app
            // with one confirmation toast and reports that toast's real result.
            Status::Unregistered | Status::Unreadable(_) | Status::Unknown(_) => Ok("prompt"),
        }
    }
    /// The only state in which a send is abandoned before `Show`.
    pub fn blocks_delivery(self) -> bool { matches!(self, Status::Disabled(_)) }
    pub fn label(self) -> &'static str {
        match self {
            Status::Enabled => "enabled",
            Status::Disabled(1) => "disabled_for_application",
            Status::Disabled(2) => "disabled_for_user",
            Status::Disabled(3) => "disabled_by_group_policy",
            Status::Disabled(_) => "disabled_by_manifest",
            Status::Unregistered => "unregistered",
            Status::PlatformUnavailable => "platform_unavailable",
            Status::Unreadable(_) => "unreadable",
            Status::Unknown(_) => "unknown",
        }
    }
}
/// Read policy once this process has had a toast accepted by `Show`: Windows
/// accepted our identity, so a still-unreadable setting is not reported as
/// "not registered" again (that would offer another confirmation toast).
pub fn read_permission(status: Status, shown: bool) -> Result<&'static str, &'static str> {
    match status {
        Status::Unregistered | Status::Unreadable(_) | Status::Unknown(_) if shown => Ok("granted"),
        _ => status.permission(),
    }
}
pub fn delivery_gate(status: Status) -> Result<(), &'static str> {
    if status.blocks_delivery() { Err("native_notification_permission_denied") } else { Ok(()) }
}
/// Error for a failed `Show`; `fallback` is the caller's generic error.
pub fn show_error(code: i32, fallback: &'static str) -> &'static str {
    match code {
        WPN_E_PLATFORM_UNAVAILABLE => "native_notification_platform_unavailable",
        // The shortcut identity was accepted locally but Windows did not resolve it.
        ERROR_NOT_FOUND => "native_notification_identity_unresolved",
        _ => fallback,
    }
}

/// Result of inspecting one Start Menu shortcut.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Probe {
    /// Targets this executable and carries our AUMID and activator CLSID.
    Verified,
    /// Targets this executable but lacks (or has other) notification properties.
    Owned,
    /// Absent, unreadable, or targets another executable: never modified.
    Foreign,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Identity<P> {
    Verified { path: P, receipt: bool },
    Repairable(P),
    Missing,
}
/// Tier 1 (read-only): the receipt's shortcut first, then the installer's known
/// locations. Candidates are probed lazily, only when the receipt is not valid.
pub fn resolve_identity<P>(receipt: Option<(P, Probe)>, candidates: impl IntoIterator<Item = (P, Probe)>) -> Identity<P> {
    let mut owned = None;
    match receipt {
        Some((path, Probe::Verified)) => return Identity::Verified { path, receipt: true },
        Some((path, Probe::Owned)) => owned = Some(path),
        _ => {}
    }
    for (path, probe) in candidates {
        match probe {
            Probe::Verified => return Identity::Verified { path, receipt: false },
            Probe::Owned if owned.is_none() => owned = Some(path),
            _ => {}
        }
    }
    owned.map_or(Identity::Missing, Identity::Repairable)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Registration {
    /// The setting was already readable; no confirmation toast was needed.
    NotNeeded,
    /// The confirmation toast was accepted and the setting became readable.
    Confirmed,
    /// The confirmation toast was accepted but the setting stayed unreadable.
    Unverified,
    /// The confirmation toast was rejected.
    Failed,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct Failure { pub stage: &'static str, pub code: String }

/// Bounded support data. Category labels and HRESULTs only: no path, user name,
/// Host, conversation or notification content.
#[derive(Clone, Debug, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Diagnostics {
    #[serde(skip_serializing_if = "Option::is_none")] pub identity: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")] pub receipt: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")] pub shortcut: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")] pub repaired: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")] pub setting: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")] pub settings_key: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")] pub registration: Option<Registration>,
    #[serde(skip_serializing_if = "Option::is_none")] pub error: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")] pub failure: Option<Failure>,
    /// Last HRESULT per native step; `0x00000000` is success.
    pub steps: BTreeMap<&'static str, String>,
}
/// Our own error codes, so a retained error can never carry arbitrary text.
const ERRORS: &[&str] = &["native_notification_unavailable", "native_notification_windows_version", "native_notification_install_required",
    "native_notification_registration_failed", "native_notification_platform_unavailable", "native_notification_identity_unresolved",
    "native_notification_permission_failed", "native_notification_permission_denied", "native_notification_delivery_failed", "invalid_notification"];
pub fn known_error(error: &str) -> Option<&'static str> { Some(ERRORS.iter().copied().find(|known| *known == error).unwrap_or("other")) }
impl Diagnostics {
    pub const fn new() -> Self {
        Self { identity: None, receipt: None, shortcut: None, repaired: None, setting: None, settings_key: None, registration: None, error: None, failure: None, steps: BTreeMap::new() }
    }
    pub fn step(&mut self, stage: &'static str, result: Result<(), i32>) {
        let code = result.err().unwrap_or(0);
        self.steps.insert(stage, hresult(code));
        if code != 0 { self.failure = Some(Failure { stage, code: hresult(code) }); }
    }
    /// Fold one operation into the retained record. A permission operation
    /// (`reset`) replaces the previous error; a send only adds to it.
    pub fn merge(&mut self, next: Diagnostics, reset: bool) {
        if reset { self.error = None; self.failure = None; self.registration = None; self.repaired = None; }
        let Diagnostics { identity, receipt, shortcut, repaired, setting, settings_key, registration, error, failure, steps } = next;
        if identity.is_some() { self.identity = identity; self.receipt = receipt; self.shortcut = shortcut; }
        if repaired.is_some() { self.repaired = repaired; }
        if setting.is_some() { self.setting = setting; }
        if settings_key.is_some() { self.settings_key = settings_key; }
        if registration.is_some() { self.registration = registration; }
        if error.is_some() { self.error = error; }
        if failure.is_some() { self.failure = failure; }
        self.steps.extend(steps);
    }
    pub fn report(&self, app_id: &str) -> String {
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Report<'a> { schema: u8, app_id: &'a str, #[serde(flatten)] diagnostics: &'a Diagnostics }
        serde_json::to_string(&Report { schema: 1, app_id, diagnostics: self }).unwrap_or_else(|_| "{}".into())
    }
}

/// The WinRT operations of an explicit request, replaced by a fake in tests.
pub trait Toasts {
    fn read(&mut self) -> Result<i32, i32>;
    /// Shows the visible confirmation toast.
    fn confirm(&mut self) -> Result<(), i32>;
    fn pause(&mut self);
}
pub fn read(toasts: &mut impl Toasts, diagnostics: &mut Diagnostics) -> Status {
    let raw = toasts.read();
    diagnostics.step("setting", raw.map(|_| ()));
    let status = classify(raw);
    diagnostics.setting = Some(status.label());
    status
}
/// `permission(true)`, only after the user turned reminders on or asked for a
/// repair. Without a readable setting, one visible confirmation toast creates
/// the notification profile; the setting is then read again.
pub fn request(toasts: &mut impl Toasts, diagnostics: &mut Diagnostics) -> Result<&'static str, &'static str> {
    match read(toasts, diagnostics) {
        Status::Enabled => { diagnostics.registration = Some(Registration::NotNeeded); return Ok("granted"); }
        Status::Disabled(_) => { diagnostics.registration = Some(Registration::NotNeeded); return Ok("denied"); }
        _ => {}
    }
    if let Err(code) = toasts.confirm() {
        diagnostics.step("confirm", Err(code));
        diagnostics.registration = Some(Registration::Failed);
        return Err(show_error(code, "native_notification_permission_failed"));
    }
    diagnostics.step("confirm", Ok(()));
    for attempt in 0..=CONFIRMATION_RETRIES {
        if attempt > 0 { toasts.pause(); }
        match read(toasts, diagnostics) {
            Status::Enabled => { diagnostics.registration = Some(Registration::Confirmed); return Ok("granted"); }
            // Windows accepted the toast but the user or policy blocks this app.
            Status::Disabled(_) => { diagnostics.registration = Some(Registration::Confirmed); return Ok("denied"); }
            _ => {}
        }
    }
    // Show succeeded: Windows accepted our identity. Do not block on a profile
    // the system has not exposed yet; the next read or send reports the truth.
    diagnostics.registration = Some(Registration::Unverified);
    Ok("granted")
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Fake { reads: Vec<Result<i32, i32>>, show: Result<(), i32>, shown: usize, pauses: usize }
    impl Fake { fn new(reads: &[Result<i32, i32>], show: Result<(), i32>) -> Self { Self { reads: reads.iter().rev().copied().collect(), show, shown: 0, pauses: 0 } } }
    impl Toasts for Fake {
        fn read(&mut self) -> Result<i32, i32> { self.reads.pop().expect("unexpected extra read") }
        fn confirm(&mut self) -> Result<(), i32> { self.shown += 1; self.show }
        fn pause(&mut self) { self.pauses += 1; }
    }
    const E_FAIL: i32 = 0x8000_4005_u32 as i32;

    #[test]
    fn read_policy_separates_unregistered_from_disabled() {
        let table = [
            (Ok(0), Ok("granted"), false, "enabled"),
            (Ok(1), Ok("denied"), true, "disabled_for_application"),
            (Ok(2), Ok("denied"), true, "disabled_for_user"),
            (Ok(3), Ok("denied"), true, "disabled_by_group_policy"),
            (Ok(4), Ok("denied"), true, "disabled_by_manifest"),
            (Ok(9), Ok("prompt"), false, "unknown"),
            (Err(ERROR_NOT_FOUND), Ok("prompt"), false, "unregistered"),
            (Err(WPN_E_PLATFORM_UNAVAILABLE), Err("native_notification_platform_unavailable"), false, "platform_unavailable"),
            (Err(E_FAIL), Ok("prompt"), false, "unreadable"),
        ];
        for (read, permission, blocks, label) in table {
            let status = classify(read);
            assert_eq!(status.permission(), permission, "{read:?}");
            assert_eq!(status.blocks_delivery(), blocks, "{read:?}");
            assert_eq!(delivery_gate(status).is_err(), blocks, "{read:?}");
            assert_eq!(status.label(), label, "{read:?}");
        }
        assert_eq!(delivery_gate(classify(Ok(1))), Err("native_notification_permission_denied"));
        // After an accepted toast an unreadable setting no longer asks to register again;
        // an explicit setting and an unavailable platform are still reported as they are.
        for (read, before, after) in [(Err(ERROR_NOT_FOUND), Ok("prompt"), Ok("granted")), (Err(E_FAIL), Ok("prompt"), Ok("granted")), (Ok(9), Ok("prompt"), Ok("granted")),
            (Ok(0), Ok("granted"), Ok("granted")), (Ok(1), Ok("denied"), Ok("denied")), (Err(WPN_E_PLATFORM_UNAVAILABLE), Err("native_notification_platform_unavailable"), Err("native_notification_platform_unavailable"))] {
            assert_eq!(read_permission(classify(read), false), before, "{read:?}");
            assert_eq!(read_permission(classify(read), true), after, "{read:?}");
        }
    }
    #[test]
    fn show_failures_keep_distinct_codes() {
        assert_eq!(show_error(WPN_E_PLATFORM_UNAVAILABLE, "fallback"), "native_notification_platform_unavailable");
        assert_eq!(show_error(ERROR_NOT_FOUND, "fallback"), "native_notification_identity_unresolved");
        assert_eq!(show_error(E_FAIL, "fallback"), "fallback");
        assert_eq!(hresult(ERROR_NOT_FOUND), "0x80070490");
        assert_eq!(hresult(0), "0x00000000");
    }
    #[test]
    fn request_registers_an_unregistered_app_with_one_confirmation() {
        let mut fake = Fake::new(&[Err(ERROR_NOT_FOUND), Err(ERROR_NOT_FOUND), Ok(0)], Ok(()));
        let mut diagnostics = Diagnostics::default();
        assert_eq!(request(&mut fake, &mut diagnostics), Ok("granted"));
        assert_eq!((fake.shown, fake.pauses), (1, 1));
        assert_eq!(diagnostics.registration, Some(Registration::Confirmed));
        assert_eq!(diagnostics.setting, Some("enabled"));
        assert_eq!(diagnostics.steps["confirm"], "0x00000000");
        assert_eq!(diagnostics.steps["setting"], "0x00000000");
        // The earlier unreadable setting remains visible to support.
        assert_eq!(diagnostics.failure, Some(Failure { stage: "setting", code: "0x80070490".into() }));
    }
    #[test]
    fn request_without_a_readable_setting_after_show_is_granted_but_unverified() {
        let reads = [Err(ERROR_NOT_FOUND); 1 + 1 + CONFIRMATION_RETRIES];
        let mut fake = Fake::new(&reads, Ok(()));
        let mut diagnostics = Diagnostics::default();
        assert_eq!(request(&mut fake, &mut diagnostics), Ok("granted"));
        assert_eq!((fake.shown, fake.pauses), (1, CONFIRMATION_RETRIES));
        assert!(fake.reads.is_empty());
        assert_eq!(diagnostics.registration, Some(Registration::Unverified));
        assert!(CONFIRMATION_RETRIES as u64 * CONFIRMATION_PAUSE_MS < 1000);
    }
    #[test]
    fn request_reports_a_failed_confirmation_by_hresult() {
        for (code, error) in [(E_FAIL, "native_notification_permission_failed"), (ERROR_NOT_FOUND, "native_notification_identity_unresolved"), (WPN_E_PLATFORM_UNAVAILABLE, "native_notification_platform_unavailable")] {
            let mut fake = Fake::new(&[Err(ERROR_NOT_FOUND)], Err(code));
            let mut diagnostics = Diagnostics::default();
            assert_eq!(request(&mut fake, &mut diagnostics), Err(error));
            assert_eq!(diagnostics.registration, Some(Registration::Failed));
            assert_eq!(diagnostics.failure, Some(Failure { stage: "confirm", code: hresult(code) }));
        }
    }
    #[test]
    fn request_never_shows_a_toast_over_an_explicit_setting() {
        for (read, expected) in [(Ok(0), "granted"), (Ok(1), "denied"), (Ok(2), "denied"), (Ok(3), "denied")] {
            let mut fake = Fake::new(&[read], Ok(()));
            let mut diagnostics = Diagnostics::default();
            assert_eq!(request(&mut fake, &mut diagnostics), Ok(expected));
            assert_eq!(fake.shown, 0);
            assert_eq!(diagnostics.registration, Some(Registration::NotNeeded));
        }
        // Registration that reveals a disabled app reports denied, not granted.
        let mut fake = Fake::new(&[Err(ERROR_NOT_FOUND), Ok(1)], Ok(()));
        assert_eq!(request(&mut fake, &mut Diagnostics::default()), Ok("denied"));
        assert_eq!(fake.shown, 1);
    }
    #[test]
    fn request_still_tries_when_the_platform_or_setting_is_unreadable() {
        for first in [Err(WPN_E_PLATFORM_UNAVAILABLE), Err(E_FAIL), Ok(7)] {
            let mut fake = Fake::new(&[first, Ok(0)], Ok(()));
            assert_eq!(request(&mut fake, &mut Diagnostics::default()), Ok("granted"), "{first:?}");
            assert_eq!(fake.shown, 1);
        }
    }
    #[test]
    fn identity_prefers_the_receipt_then_known_locations_and_only_repairs_owned_links() {
        let probed = std::cell::Cell::new(0);
        let lazy = |items: Vec<(&'static str, Probe)>| { let probed = &probed; items.into_iter().inspect(move |_| probed.set(probed.get() + 1)) };
        assert_eq!(resolve_identity(Some(("receipt", Probe::Verified)), lazy(vec![("a", Probe::Verified)])), Identity::Verified { path: "receipt", receipt: true });
        assert_eq!(probed.get(), 0, "a valid receipt probes no other location");
        assert_eq!(resolve_identity(None, lazy(vec![("a", Probe::Foreign), ("b", Probe::Verified)])), Identity::Verified { path: "b", receipt: false });
        assert_eq!(resolve_identity(Some(("receipt", Probe::Owned)), lazy(vec![("a", Probe::Owned), ("b", Probe::Verified)])), Identity::Verified { path: "b", receipt: false });
        assert_eq!(resolve_identity(Some(("receipt", Probe::Owned)), lazy(vec![("a", Probe::Owned)])), Identity::Repairable("receipt"));
        assert_eq!(resolve_identity(Some(("receipt", Probe::Foreign)), lazy(vec![("a", Probe::Foreign), ("b", Probe::Owned)])), Identity::Repairable("b"));
        assert_eq!(resolve_identity(None, lazy(vec![("a", Probe::Foreign)])), Identity::Missing);
        assert_eq!(resolve_identity::<&str>(None, Vec::new()), Identity::Missing);
    }
    #[test]
    fn diagnostics_are_bounded_path_free_and_reset_per_permission_operation() {
        let mut retained = Diagnostics::default();
        let mut first = Diagnostics { identity: Some("verified"), receipt: Some("valid"), shortcut: Some("programs"), error: Some("native_notification_permission_failed"), ..Default::default() };
        first.step("confirm", Err(E_FAIL));
        retained.merge(first, true);
        let mut send = Diagnostics::default(); send.step("show", Ok(()));
        retained.merge(send, false);
        assert_eq!(retained.error, Some("native_notification_permission_failed"), "a send keeps the last permission error");
        let json: serde_json::Value = serde_json::from_str(&retained.report("com.opensuperagent.client")).unwrap();
        assert_eq!(json, serde_json::json!({ "schema": 1, "appId": "com.opensuperagent.client", "identity": "verified", "receipt": "valid", "shortcut": "programs",
            "error": "native_notification_permission_failed", "failure": { "stage": "confirm", "code": "0x80004005" }, "steps": { "confirm": "0x80004005", "show": "0x00000000" } }));
        retained.merge(Diagnostics { setting: Some("enabled"), ..Default::default() }, true);
        assert_eq!((retained.error, retained.failure.clone(), retained.identity), (None, None, Some("verified")));
        assert!(retained.report("com.opensuperagent.client").len() < 1024);
        assert_eq!(Diagnostics::new(), Diagnostics::default());
        assert_eq!(known_error("native_notification_install_required"), Some("native_notification_install_required"));
        assert_eq!(known_error("C:\\Users\\example\\Desktop"), Some("other"));
    }
}
