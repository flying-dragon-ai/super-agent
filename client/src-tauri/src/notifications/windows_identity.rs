//! Protocol-only toasts need an installed Start Menu shortcut with our AUMID
//! and a stub CLSID. No COM server or LocalServer32 entry is registered.
//!
//! Identity self-heal tiers (decisions in `windows_status::resolve_identity`):
//! 1. every check, read-only: the receipt's shortcut, then the installer's
//!    known Start Menu locations;
//! 2. explicit permission request only: stamp our properties on a shortcut that
//!    already targets this executable and rewrite the receipt (`register`);
//! 3. user click only: the main process creates `Programs\open-super-agent.lnk`, then
//!    `adopt_created_shortcut` verifies and registers it;
//! 4. not implemented: see `register_app_user_model_id` below.
use super::{windows::Apartment, windows_payload::APP_ID, windows_status::{self as status, Diagnostics, Identity, Probe}};
use std::{ffi::OsString, io::Read, os::windows::ffi::OsStringExt, path::{Path, PathBuf}};
use windows::{core::{BSTR, GUID, HSTRING, Interface}, Win32::{
    Storage::EnhancedStorage::{PKEY_AppUserModel_ID, PKEY_AppUserModel_ToastActivatorCLSID},
    System::Com::{CoCreateInstance, CoTaskMemFree, IPersistFile, CLSCTX_INPROC_SERVER, STGM_READ, STGM_READWRITE,
        StructuredStorage::{InitPropVariantFromCLSID, PropVariantToGUID, PROPVARIANT}},
    UI::Shell::{FOLDERID_Programs, IShellLinkW, SHGetKnownFolderPath, ShellLink, KF_FLAG_DEFAULT, PropertiesSystem::IPropertyStore},
}};

const STUB_CLSID: GUID = GUID::from_u128(0x5e8c5c51_d485_4c46_b76a_02547bcd6776);
const RECEIPT: &str = "open-super-agent-notification-shortcut.json";
/// `DISPLAYNAME` and `PRODUCTNAME` of `windows-electron/installer.nsi`.
const DISPLAY_NAME: &str = "open-super-agent";
const PRODUCT_NAME: &str = "Open Super Agent";
fn receipt_path() -> Result<PathBuf, String> {
    Ok(std::env::current_exe().map_err(|_| "native_notification_install_required")?.with_file_name(RECEIPT))
}
fn shortcut(path: &Path, write: bool) -> Result<(IPersistFile, IPropertyStore), String> {
    if !path.is_absolute() || !path.is_file() || !path.extension().is_some_and(|ext| ext.eq_ignore_ascii_case("lnk")) {
        return Err("native_notification_install_required".into());
    }
    // Load only an existing link, then verify ownership before any mutation.
    let link: IShellLinkW = unsafe { CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER) }.map_err(|_| "native_notification_install_required")?;
    let persist: IPersistFile = link.cast().map_err(|_| "native_notification_install_required")?;
    unsafe { persist.Load(&HSTRING::from(path.as_os_str()), if write { STGM_READWRITE } else { STGM_READ }) }.map_err(|_| "native_notification_install_required")?;
    let mut target = vec![0u16; 32768];
    unsafe { link.GetPath(&mut target, std::ptr::null_mut(), 0) }.map_err(|_| "native_notification_install_required")?;
    let end = target.iter().position(|ch| *ch == 0).ok_or("native_notification_install_required")?;
    let target = std::fs::canonicalize(PathBuf::from(OsString::from_wide(&target[..end]))).map_err(|_| "native_notification_install_required")?;
    let exe = std::fs::canonicalize(std::env::current_exe().map_err(|_| "native_notification_install_required")?).map_err(|_| "native_notification_install_required")?;
    if target != exe { return Err("native_notification_install_required".into()); }
    let properties = link.cast().map_err(|_| "native_notification_install_required")?;
    Ok((persist, properties))
}
fn properties_match(properties: &IPropertyStore) -> bool {
    let id = unsafe { properties.GetValue(&PKEY_AppUserModel_ID) }.ok().and_then(|id| BSTR::try_from(&id).ok());
    let clsid = unsafe { properties.GetValue(&PKEY_AppUserModel_ToastActivatorCLSID) }.ok().and_then(|clsid| unsafe { PropVariantToGUID(&clsid) }.ok());
    id.is_some_and(|id| APP_ID == id) && clsid == Some(STUB_CLSID)
}
fn verify_shortcut(path: &Path) -> Result<(), String> {
    let (_persist, properties) = shortcut(path, false)?;
    if properties_match(&properties) { Ok(()) } else { Err("native_notification_install_required".into()) }
}
fn probe(path: &Path) -> Probe {
    match shortcut(path, false) {
        Ok((_persist, properties)) if properties_match(&properties) => Probe::Verified,
        Ok(_) => Probe::Owned,
        Err(_) => Probe::Foreign,
    }
}
/// The receipt's recorded shortcut, or the receipt state label on failure.
fn receipt() -> Result<PathBuf, &'static str> {
    let file = match receipt_path().ok().map(std::fs::File::open) {
        Some(Ok(file)) => file,
        Some(Err(error)) if error.kind() == std::io::ErrorKind::NotFound => return Err("missing"),
        _ => return Err("invalid"),
    };
    let mut data = Vec::new(); file.take(32769).read_to_end(&mut data).map_err(|_| "invalid")?;
    if data.len() > 32768 { return Err("invalid"); }
    serde_json::from_slice(&data).map_err(|_| "invalid")
}
/// The current user's Start Menu Programs folder (Known Folder, so a
/// redirected profile resolves correctly).
fn programs_folder() -> Option<PathBuf> {
    let raw = unsafe { SHGetKnownFolderPath(&FOLDERID_Programs, KF_FLAG_DEFAULT, None) }.ok()?;
    let path = PathBuf::from(OsString::from_wide(unsafe { raw.as_wide() }));
    unsafe { CoTaskMemFree(Some(raw.0 as *const _)) };
    path.is_absolute().then_some(path)
}
/// The installer's POSTINSTALL candidates (its Start Menu folder page is
/// skipped, so the folder is empty or the product name) in the order of the
/// acceptance check, with a path-free category for diagnostics. A user-chosen
/// folder is found through the receipt.
fn candidates() -> Vec<(PathBuf, &'static str)> {
    let Some(programs) = programs_folder() else { return Vec::new() };
    vec![
        (programs.join(format!("{DISPLAY_NAME}.lnk")), "programs"),
        (programs.join(PRODUCT_NAME).join(format!("{DISPLAY_NAME}.lnk")), "programs_folder"),
        (programs.join(format!("{PRODUCT_NAME}.lnk")), "legacy"),
        (programs.join(PRODUCT_NAME).join(format!("{PRODUCT_NAME}.lnk")), "legacy"),
    ]
}
fn same_path(a: &Path, b: &Path) -> bool { a.as_os_str().to_string_lossy().to_lowercase() == b.as_os_str().to_string_lossy().to_lowercase() }
/// Tier 1. Read-only: never writes a shortcut, receipt or registry value.
pub fn resolve(diagnostics: &mut Diagnostics) -> Identity<PathBuf> {
    let known = candidates();
    let category = |path: &Path| known.iter().find(|(known, _)| same_path(known, path)).map_or("other", |(_, label)| *label);
    let recorded = receipt();
    let identity = status::resolve_identity(recorded.as_ref().ok().map(|path| (path.clone(), probe(path))),
        known.iter().map(|(path, _)| (path.clone(), probe(path))));
    let (label, path) = match &identity {
        Identity::Verified { path, .. } => ("verified", Some(path)),
        Identity::Repairable(path) => ("repairable", Some(path)),
        Identity::Missing => ("missing", None),
    };
    diagnostics.identity = Some(label);
    diagnostics.shortcut = path.map(|path| category(path));
    diagnostics.receipt = Some(match (&recorded, &identity) {
        (Err(state), _) => state,
        (Ok(_), Identity::Verified { receipt: true, .. }) => "valid",
        (Ok(_), _) => "stale",
    });
    identity
}
/// Tier 2 (inside an explicit request): make the shortcut that already targets
/// this executable carry our identity, and point the receipt at it.
pub fn repair(identity: Identity<PathBuf>, diagnostics: &mut Diagnostics) -> Result<(), String> {
    match identity {
        Identity::Verified { receipt: true, .. } => Ok(()),
        // Already verified: refreshing the stale receipt is best-effort.
        Identity::Verified { path, receipt: false } => { if register(&path).is_ok() { diagnostics.repaired = Some("receipt"); diagnostics.receipt = Some("valid"); } Ok(()) }
        Identity::Repairable(path) => {
            register(&path)?;
            diagnostics.repaired = Some("shortcut"); diagnostics.identity = Some("verified"); diagnostics.receipt = Some("valid");
            Ok(())
        }
        // Tier 3 needs the user's click; never create a shortcut implicitly.
        Identity::Missing => Err("native_notification_install_required".into()),
    }
}
/// Tier 3 location: `Programs\open-super-agent.lnk`.
pub fn shortcut_path() -> Result<PathBuf, String> {
    programs_folder().map(|programs| programs.join(format!("{DISPLAY_NAME}.lnk"))).ok_or_else(|| "native_notification_install_required".into())
}
/// Tier 3, after the user asked for it and the main process wrote the link.
/// `register` verifies that the link targets this executable before any write.
pub fn adopt_created_shortcut() -> Result<(), String> { register(&shortcut_path()?) }
/// Tier 4 seam, deliberately not implemented: registering
/// `HKCU\Software\Classes\AppUserModelId\com.opensuperagent.client` (DisplayName,
/// IconUri) waits for the real-device comparison of shortcut-only, registry-only
/// and both. It would need the `Win32_System_Registry` write APIs, an icon file
/// outside app.asar, installer POSTINSTALL/uninstall pairing and an idempotent
/// runtime rewrite.
#[allow(dead_code)]
fn register_app_user_model_id() -> Result<(), String> { Err("native_notification_registration_unavailable".into()) }
pub fn verify_installed() -> Result<(), String> {
    verify_shortcut(&receipt().map_err(|_| "native_notification_install_required")?)
}
fn register(path: &Path) -> Result<(), String> {
    let _apartment = Apartment::enter()?;
    let (persist, properties) = shortcut(path, true)?;
    let id = PROPVARIANT::from(APP_ID);
    let clsid = unsafe { InitPropVariantFromCLSID(&STUB_CLSID) }.map_err(|_| "native_notification_registration_failed")?;
    unsafe {
        properties.SetValue(&PKEY_AppUserModel_ID, &id)
            .and_then(|_| properties.SetValue(&PKEY_AppUserModel_ToastActivatorCLSID, &clsid))
            .and_then(|_| properties.Commit())
            .and_then(|_| persist.Save(&HSTRING::from(path.as_os_str()), true))
    }.map_err(|_| "native_notification_registration_failed")?;
    drop(properties); drop(persist);
    verify_shortcut(path)?;
    let data = serde_json::to_vec(path).map_err(|_| "native_notification_registration_failed")?;
    std::fs::write(receipt_path()?, data).map_err(|_| "native_notification_registration_failed")?;
    verify_installed()
}
/// Run before Tauri/single-instance initialization: an installer registration
/// must exit with a result instead of being forwarded to an already running UI.
pub fn installer_command() -> Option<i32> {
    let args: Vec<_> = std::env::args_os().collect();
    if args.get(1).is_some_and(|arg| arg == "--clear-notification-history") {
        return Some(if args.len() == 2 && super::windows::clear(None).is_ok() { 0 } else { 1 });
    }
    if args.get(1).is_none_or(|arg| arg != "--register-notification-shortcut") { return None; }
    Some(if args.len() == 3 && register(Path::new(&args[2])).is_ok() { 0 } else { 1 })
}
