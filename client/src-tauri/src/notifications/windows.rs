use super::{state::{Notice, Submission}, windows_identity, windows_payload::{self, APP_ID}, windows_status::{self as status, Diagnostics, Identity}};
use std::sync::{atomic::{AtomicBool, Ordering}, Arc, Mutex, PoisonError};
use windows::{core::HSTRING, Data::Xml::Dom::XmlDocument, Foundation::Metadata::ApiInformation,
    UI::Notifications::{ToastNotification, ToastNotificationManager, ToastNotifier},
    Win32::{Foundation::{ERROR_FILE_NOT_FOUND, ERROR_SUCCESS, RPC_E_CHANGED_MODE},
        System::{Registry::{RegCloseKey, RegOpenKeyExW, HKEY, HKEY_CURRENT_USER, KEY_READ}, WinRT::{RoInitialize, RoUninitialize, RO_INIT_MULTITHREADED}}}};

/// Retained across operations for `diagnostics()`; never holds a path or content.
static DIAGNOSTICS: Mutex<Diagnostics> = Mutex::new(Diagnostics::new());
fn retain(next: Diagnostics, reset: bool) { DIAGNOSTICS.lock().unwrap_or_else(PoisonError::into_inner).merge(next, reset); }
pub fn diagnostics() -> String { DIAGNOSTICS.lock().unwrap_or_else(PoisonError::into_inner).report(APP_ID) }
fn code(error: windows::core::Error) -> i32 { error.code().0 }
/// Set once Windows accepted any toast from this process (confirmation or send).
static SHOWN: AtomicBool = AtomicBool::new(false);

/// WinRT objects never escape the blocking worker or outlive its apartment.
pub(super) struct Apartment(bool);
impl Apartment {
    pub fn enter() -> Result<Self, String> {
        match unsafe { RoInitialize(RO_INIT_MULTITHREADED) } {
            Ok(()) => Ok(Self(true)),
            Err(error) if error.code() == RPC_E_CHANGED_MODE => Ok(Self(false)),
            Err(error) => {
                let mut failed = Diagnostics::default(); failed.step("apartment", Err(code(error))); retain(failed, false);
                Err("native_notification_unavailable".into())
            }
        }
    }
}
impl Drop for Apartment { fn drop(&mut self) { if self.0 { unsafe { RoUninitialize(); } } } }
fn contract(diagnostics: &mut Diagnostics) -> Result<(), String> {
    // 15063 / UniversalApiContract v4 is the first version allowing 64-char groups.
    let present = ApiInformation::IsApiContractPresentByMajor(&HSTRING::from("Windows.Foundation.UniversalApiContract"), 4)
        .map_err(|error| { diagnostics.step("contract", Err(code(error))); "native_notification_unavailable" })?;
    if present { Ok(()) } else { Err("native_notification_windows_version".into()) }
}
fn notifier(diagnostics: &mut Diagnostics) -> Result<ToastNotifier, String> {
    let created = ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(APP_ID));
    diagnostics.step("notifier", created.as_ref().map(|_| ()).map_err(|error| error.code().0));
    created.map_err(|error| if code(error) == status::WPN_E_PLATFORM_UNAVAILABLE { "native_notification_platform_unavailable".into() } else { "native_notification_unavailable".into() })
}
/// Whether Windows has a notification profile key for this AUMID (read-only).
fn settings_key() -> Option<bool> {
    let path = HSTRING::from(format!("Software\\Microsoft\\Windows\\CurrentVersion\\Notifications\\Settings\\{APP_ID}"));
    let mut key = HKEY::default();
    match unsafe { RegOpenKeyExW(HKEY_CURRENT_USER, &path, None, KEY_READ, &mut key) } {
        ERROR_SUCCESS => { unsafe { let _ = RegCloseKey(key); } Some(true) }
        ERROR_FILE_NOT_FOUND => Some(false),
        _ => None,
    }
}
struct Live<'a> { notifier: &'a ToastNotifier, confirmation: String }
impl status::Toasts for Live<'_> {
    fn read(&mut self) -> Result<i32, i32> { self.notifier.Setting().map(|setting| setting.0).map_err(code) }
    fn confirm(&mut self) -> Result<(), i32> {
        let xml = XmlDocument::new().map_err(code)?;
        xml.LoadXml(&HSTRING::from(&self.confirmation)).map_err(code)?;
        let toast = ToastNotification::CreateToastNotification(&xml).map_err(code)?;
        toast.SetTag(&HSTRING::from(windows_payload::CONFIRMATION_TAG)).and_then(|_| toast.SetGroup(&HSTRING::from(windows_payload::CONFIRMATION_GROUP))).map_err(code)?;
        self.notifier.Show(&toast).map_err(code)
    }
    fn pause(&mut self) { std::thread::sleep(std::time::Duration::from_millis(status::CONFIRMATION_PAUSE_MS)); }
}
/// `request == false` is read-only: it never shows a toast or writes anything.
/// `request == true` comes only from turning reminders on or a repair click.
pub fn permission(request: bool, confirmation: Option<String>) -> Result<String, String> {
    let mut diagnostics = Diagnostics::default();
    let result = permission_in(request, confirmation, &mut diagnostics);
    if let Err(error) = &result { diagnostics.error = status::known_error(error); }
    retain(diagnostics, true);
    result
}
fn permission_in(request: bool, confirmation: Option<String>, diagnostics: &mut Diagnostics) -> Result<String, String> {
    // Validate the caller's text before any repair or toast.
    let confirmation = if request { Some(windows_payload::confirmation_xml(confirmation.as_deref().unwrap_or(windows_payload::DEFAULT_CONFIRMATION))?) } else { None };
    let _apartment = Apartment::enter()?;
    contract(diagnostics)?;
    let identity = windows_identity::resolve(diagnostics);
    let Some(confirmation) = confirmation else {
        match identity {
            Identity::Missing => return Err("native_notification_install_required".into()),
            // Repair is a write; a read only reports that a request can fix it.
            Identity::Repairable(_) => return Ok("prompt".into()),
            Identity::Verified { .. } => {}
        }
        let notifier = notifier(diagnostics)?;
        let read = status::read(&mut Live { notifier: &notifier, confirmation: String::new() }, diagnostics);
        diagnostics.settings_key = settings_key();
        return status::read_permission(read, SHOWN.load(Ordering::Acquire)).map(Into::into).map_err(Into::into);
    };
    // Tiers 1-2 only. A missing shortcut needs the user's explicit tier-3 click.
    windows_identity::repair(identity, diagnostics)?;
    let notifier = notifier(diagnostics)?;
    let result = status::request(&mut Live { notifier: &notifier, confirmation }, diagnostics);
    if matches!(diagnostics.registration, Some(status::Registration::Confirmed | status::Registration::Unverified)) { SHOWN.store(true, Ordering::Release); }
    diagnostics.settings_key = settings_key();
    result.map(Into::into).map_err(Into::into)
}
pub fn send(notice: Notice, submission: Arc<Submission>) -> Result<(), String> {
    let mut diagnostics = Diagnostics::default();
    let result = send_in(notice, submission, &mut diagnostics);
    retain(diagnostics, false);
    result
}
fn send_in(notice: Notice, submission: Arc<Submission>, diagnostics: &mut Diagnostics) -> Result<(), String> {
    let _apartment = Apartment::enter()?;
    contract(diagnostics)?;
    if !matches!(windows_identity::resolve(diagnostics), Identity::Verified { .. }) { return Err("native_notification_install_required".into()); }
    let notifier = notifier(diagnostics)?;
    // Give up only on an explicit Disabled* setting. Before the first toast the
    // setting is unreadable; Show creates the profile and Windows itself drops
    // the toast if the user has disabled it. In-app consent is checked earlier.
    status::delivery_gate(status::read(&mut Live { notifier: &notifier, confirmation: String::new() }, diagnostics))?;
    let xml = XmlDocument::new().map_err(|_| "native_notification_delivery_failed")?;
    xml.LoadXml(&HSTRING::from(windows_payload::toast_xml(&notice)?)).map_err(|_| "native_notification_delivery_failed")?;
    let toast = ToastNotification::CreateToastNotification(&xml).map_err(|_| "native_notification_delivery_failed")?;
    let tag = HSTRING::from(&submission.id); let group = HSTRING::from(windows_payload::host_group(&notice.host_id)?);
    toast.SetTag(&tag).and_then(|_| toast.SetGroup(&group)).map_err(|_| "native_notification_delivery_failed")?;
    if !submission.active() { return Err("native_notification_cancelled".into()); }
    let shown = notifier.Show(&toast).map_err(code);
    diagnostics.step("show", shown);
    shown.map_err(|code| status::show_error(code, "native_notification_delivery_failed"))?;
    SHOWN.store(true, Ordering::Release);
    if !submission.active() {
        // A clear can race Show; remove only this unique submission, never its replacement.
        ToastNotificationManager::History().and_then(|history| history.RemoveGroupedTagWithId(&tag, &group, &HSTRING::from(APP_ID)))
            .map_err(|_| "native_notification_clear_failed")?;
        return Err("native_notification_cancelled".into());
    }
    Ok(())
}
pub fn clear(host: Option<String>) -> Result<(), String> {
    let _apartment = Apartment::enter()?;
    // History uses our explicit AUMID even if the shortcut was subsequently
    // removed. Do not strand delivered private notices behind an install check.
    let history = ToastNotificationManager::History().map_err(|_| "native_notification_clear_failed")?;
    match host {
        Some(host) => history.RemoveGroupWithId(&HSTRING::from(windows_payload::host_group(&host)?), &HSTRING::from(APP_ID)),
        None => history.ClearWithId(&HSTRING::from(APP_ID)),
    }.map_err(|_| "native_notification_clear_failed".into())
}

#[cfg(test)]
mod tests {
    /// Record-only probe for the `windows-latest` runner (run with `--ignored`):
    /// a never-registered AUMID must classify as prompt or granted, never as a
    /// read error. Prints the real HRESULT; proves nothing about delivery.
    #[test]
    #[ignore]
    fn windows_toast_status_probe() {
        let _apartment = super::Apartment::enter().unwrap();
        let id = format!("com.opensuperagent.probe.{}", uuid::Uuid::new_v4().simple());
        let read = super::ToastNotificationManager::CreateToastNotifierWithId(&super::HSTRING::from(&id))
            .and_then(|notifier| notifier.Setting()).map(|setting| setting.0).map_err(super::code);
        let classified = super::status::classify(read);
        println!("probe setting read: {}; classified: {}; permission: {:?}",
            read.map_or_else(super::status::hresult, |value| format!("NotificationSetting({value})")), classified.label(), classified.permission());
        assert!(matches!(classified.permission(), Ok("prompt" | "granted")), "{classified:?}");
    }
}
