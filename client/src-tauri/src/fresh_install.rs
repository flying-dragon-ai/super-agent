#[cfg(windows)]
#[path = "../host-launcher/src/storage_probe.rs"]
mod storage_probe;
// Windows installer recovery. Never depends on the bundled Node runtime or
// opens a WebView. Only the current OS user's fixed application directories
// may be moved; remote hosts and custom CLI state directories are untouched.
use std::{fs, io, path::{Path, PathBuf}};

const APP_ID: &str = "com.opensuperagent.client";
const LEGACY_APP_ID: &str = "com.opensuperagent.client";

// Numeric protocol for the Electron NSIS dialogs. Do not forward OS errors or paths.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(i32)]
pub enum Reason {
    SharedService = 40,
    HostRunning = 41,
    OwnerUnknown = 42,
    ProcessUnconfirmed = 43,
    AccessDenied = 44,
    StateUnreadable = 45,
    Redirected = 46,
    DirectoryUnavailable = 47,
    InvalidRequest = 48,
    BackupExists = 49,
    CreateFailed = 50,
    CreateDenied = 51,
    MoveFailed = 52,
    MoveDenied = 53,
    HostConflict = 54,
    StopFailed = 55,
    StopTimedOut = 56,
    UpdatePending = 57,
    StorageUnconfirmed = 58,
    FinalizeFailed = 60,
}

fn read_error(error: io::Error) -> Reason {
    if error.kind() == io::ErrorKind::PermissionDenied { Reason::AccessDenied } else { Reason::StateUnreadable }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BackupFailure {
    NotStarted(Reason),
    RolledBack(Reason),
    RollbackIncomplete(Reason),
    FinalizationIncomplete,
}

impl From<Reason> for BackupFailure {
    fn from(reason: Reason) -> Self { Self::NotStarted(reason) }
}

#[derive(Debug, PartialEq, Eq)]
enum Backup { Completed, NoData }

fn backup_exit(result: Result<Backup, BackupFailure>, detailed: bool) -> i32 {
    use BackupFailure::*;
    match result {
        Ok(Backup::NoData) if detailed => 10,
        Ok(_) => 0,
        Err(failure) => match failure {
            NotStarted(reason) if detailed => reason as i32,
            RolledBack(reason) if detailed => 100 + reason as i32,
            RollbackIncomplete(reason) if detailed => 200 + reason as i32,
            FinalizationIncomplete if detailed => Reason::FinalizeFailed as i32,
            // Older NSIS callers understand only 21–24 and use zero for all successes.
            FinalizationIncomplete | RollbackIncomplete(_) => 24,
            NotStarted(reason) | RolledBack(reason) => match reason {
                Reason::SharedService | Reason::UpdatePending => 21,
                Reason::OwnerUnknown | Reason::HostRunning | Reason::ProcessUnconfirmed => 22,
                _ => 23,
            },
        },
    }
}

fn exists(path: &Path) -> Result<bool, Reason> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(read_error(error)),
    }
}

fn plain_directory(path: &Path) -> Result<(), Reason> {
    let metadata = fs::symlink_metadata(path).map_err(read_error)?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() { return Err(Reason::Redirected); }
    #[cfg(windows)] {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 { return Err(Reason::Redirected); }
    }
    Ok(())
}

/// An installed CLI can restart itself even while its PID is absent. Refuse to
/// reset that shared state until its service is uninstalled. Unknown/live PIDs
/// and malformed ownership records also block; never terminate an arbitrary PID.
fn host_stopped(root: &Path, alive: &impl Fn(u32, Option<u64>) -> Result<bool, Reason>) -> Result<(), Reason> {
    let host = root.join("host");
    if !exists(&host)? { return Ok(()); }
    plain_directory(&host)?;
    for name in ["host-service.json", "host-service-refresh.json"] {
        if exists(&host.join(name))? { return Err(Reason::SharedService); }
    }
    if exists(&host.join("update-in-progress.json"))? { return Err(Reason::UpdatePending); }
    let lock = host.join("instance.lock.json");
    if !exists(&lock)? { return Ok(()); }
    let metadata = fs::symlink_metadata(&lock).map_err(read_error)?;
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > 16_384 {
        return Err(Reason::OwnerUnknown);
    }
    let value: serde_json::Value = serde_json::from_slice(&fs::read(lock).map_err(read_error)?)
        .map_err(|_| Reason::OwnerUnknown)?;
    let pid = value.get("pid").and_then(|value| value.as_u64()).and_then(|pid| u32::try_from(pid).ok())
        .filter(|pid| *pid > 0).ok_or(Reason::OwnerUnknown)?;
    let birth = value.get("processBirth").and_then(|value| value.as_str()).and_then(|value| value.strip_prefix("win32:")).and_then(|value| value.parse::<u64>().ok());
    if alive(pid, birth)? { return Err(Reason::HostRunning); }
    Ok(())
}

/// Move both roots into unique sibling backup folders. Check every root before
/// changing any. A failed second move rolls the first back; never overwrite a
/// newly created directory during rollback. No recursive deletion is used.
fn reset_with(
    roots: &[PathBuf], suffix: &str,
    alive: &impl Fn(u32, Option<u64>) -> Result<bool, Reason>,
    rename: &impl Fn(&Path, &Path) -> io::Result<()>,
) -> Result<Backup, BackupFailure> {
    if suffix.is_empty() || !suffix.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-') {
        return Err(Reason::InvalidRequest.into());
    }
    let mut plan = Vec::new();
    for root in roots {
        if root.file_name().is_none_or(|name| name != APP_ID && name != LEGACY_APP_ID) { return Err(Reason::InvalidRequest.into()); }
        if plan.iter().any(|(source, _, _): &(PathBuf, PathBuf, PathBuf)| source == root) { continue; }
        if !exists(root)? { continue; }
        plain_directory(root)?;
        host_stopped(root, alive)?;
        let folder = root.parent().ok_or(Reason::InvalidRequest)?.join(format!("Open Super Agent-backup-{suffix}"));
        if exists(&folder)? { return Err(Reason::BackupExists.into()); }
        plan.push((root.clone(), folder.join(root.file_name().ok_or(Reason::InvalidRequest)?), folder));
    }
    let mut folders = Vec::new();
    for (_, _, folder) in &plan {
        if folders.contains(&folder) { continue; }
        if let Err(error) = fs::create_dir(folder) {
            for previous in folders { let _ = fs::remove_dir(previous); }
            let reason = match error.kind() {
                io::ErrorKind::PermissionDenied => Reason::CreateDenied,
                io::ErrorKind::AlreadyExists => Reason::BackupExists,
                _ => Reason::CreateFailed,
            };
            return Err(reason.into());
        }
        folders.push(folder);
    }
    let mut moved: Vec<(&PathBuf, &PathBuf)> = Vec::new();
    for (source, destination, _) in &plan {
        // Recheck immediately before moving in case an App/CLI was started
        // while the installer was asking the user to close applications.
        let result = host_stopped(source, alive).and_then(|()| {
            rename(source, destination).map_err(|error| match error.kind() {
                io::ErrorKind::PermissionDenied => Reason::MoveDenied,
                _ => Reason::MoveFailed,
            })
        });
        if let Err(reason) = result {
            let mut rolled_back = true;
            for (original, backup) in moved.iter().rev() {
                if exists(original) != Ok(false) || rename(backup, original).is_err() { rolled_back = false; }
            }
            for folder in &folders { let _ = fs::remove_dir(folder); }
            return Err(if moved.is_empty() {
                BackupFailure::NotStarted(reason)
            } else if rolled_back {
                BackupFailure::RolledBack(reason)
            } else {
                BackupFailure::RollbackIncomplete(reason)
            });
        }
        moved.push((source, destination));
    }
    // Recovery backups retain host history, not the client's installation key.
    // Otherwise restoring a fresh-start backup could resurrect remote pairing.
    // Do this only after every move commits so ordinary rollback keeps access.
    for (_, backup) in moved {
        match fs::remove_file(backup.join("open-super-agent-client-installation-v1")) {
            Ok(()) => {},
            Err(error) if error.kind() == io::ErrorKind::NotFound => {},
            Err(_) => return Err(BackupFailure::FinalizationIncomplete),
        }
    }
    Ok(if plan.is_empty() { Backup::NoData } else { Backup::Completed })
}

#[cfg(windows)]
fn process_alive(pid: u32, expected_birth: Option<u64>) -> Result<bool, Reason> {
    use windows::Win32::{Foundation::{CloseHandle, ERROR_INVALID_PARAMETER, FILETIME}, System::Threading::{OpenProcess, GetExitCodeProcess, GetProcessTimes, PROCESS_QUERY_LIMITED_INFORMATION}};
    unsafe {
        let handle = match OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) {
            Ok(handle) => handle,
            Err(error) if error.code() == ERROR_INVALID_PARAMETER.to_hresult() => return Ok(false),
            Err(_) => return Err(Reason::ProcessUnconfirmed),
        };
        let mut code = 0;
        let result = GetExitCodeProcess(handle, &mut code);
        let birth_matches = if let Some(expected) = expected_birth {
            let (mut created, mut exited, mut kernel, mut user) = (FILETIME::default(), FILETIME::default(), FILETIME::default(), FILETIME::default());
            match GetProcessTimes(handle, &mut created, &mut exited, &mut kernel, &mut user) {
                Ok(()) => Some(((created.dwHighDateTime as u64) << 32 | created.dwLowDateTime as u64) == expected),
                Err(_) => None,
            }
        } else { Some(true) };
        let _ = CloseHandle(handle);
        result.map_err(|_| Reason::ProcessUnconfirmed)?;
        Ok(code == 259 && birth_matches.ok_or(Reason::ProcessUnconfirmed)?) // STILL_ACTIVE
    }
}

#[cfg(windows)]
pub fn check_stopped() -> Result<(), Reason> {
    if storage_probe::package_family(std::process::id()) != Ok(None) { return Err(Reason::StorageUnconfirmed); }
    let base = dirs::data_dir().ok_or(Reason::DirectoryUnavailable)?;
    for id in [APP_ID, LEGACY_APP_ID] {
        let root = base.join(id);
        if exists(&root)? {
            plain_directory(&root)?;
            host_stopped(&root, &process_alive)?;
        }
    }
    Ok(())
}

#[cfg(windows)]
pub fn confirm_stopped() -> bool { check_stopped().is_ok() }

#[cfg(windows)]
pub fn installer_command() -> Option<i32> {
    let args: Vec<_> = std::env::args_os().collect();
    let command = args.get(1)?.to_str()?;
    if command == "--confirm-host-stopped" {
        return Some(if args.len() == 2 && confirm_stopped() { 0 } else { 22 });
    }
    if command == "--confirm-host-stopped-v2" {
        return Some(if args.len() != 2 { Reason::InvalidRequest as i32 }
            else { check_stopped().map_or_else(|reason| reason as i32, |()| 0) });
    }
    let detailed = match command {
        "--prepare-fresh-install" => false,
        "--prepare-fresh-install-v2" => true,
        _ => return None,
    };
    let result = (|| {
        if args.len() != 2 { return Err(Reason::InvalidRequest.into()); }
        if storage_probe::package_family(std::process::id()) != Ok(None) { return Err(Reason::StorageUnconfirmed.into()); }
        // Identical Known Folder APIs to Tauri app_data_dir/app_local_data_dir;
        // never trust an installer-provided path or a redirected APPDATA env.
        let bases = [dirs::data_dir(), dirs::data_local_dir()].into_iter()
            .map(|base| base.ok_or(Reason::DirectoryUnavailable))
            .collect::<Result<Vec<_>, _>>()?;
        let roots = bases.iter().flat_map(|base| [base.join(APP_ID), base.join(LEGACY_APP_ID)]).collect::<Vec<_>>();
        reset_with(&roots, &uuid::Uuid::new_v4().to_string(), &process_alive, &|from, to| fs::rename(from, to))
    })();
    if let Err(failure) = &result { eprintln!("{failure:?}"); }
    Some(backup_exit(result, detailed))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn setup() -> (PathBuf, Vec<PathBuf>) {
        let root = std::env::temp_dir().join(format!("open-super-agent 示例 {}", uuid::Uuid::new_v4()));
        let paths = vec![root.join("roaming").join(APP_ID), root.join("local").join(APP_ID)];
        for path in &paths { fs::create_dir_all(path).unwrap(); fs::write(path.join("identity"), b"preserve").unwrap(); }
        (root, paths)
    }
    fn rename(from: &Path, to: &Path) -> io::Result<()> { fs::rename(from, to) }
    #[test]
    fn fresh_start_preserves_backups_and_does_not_touch_other_apps() {
        let (root, paths) = setup();
        fs::write(root.join("unrelated"), "keep").unwrap();
        reset_with(&paths, "test", &|_, _| Ok(false), &rename).unwrap();
        for path in paths {
            assert!(!path.exists());
            assert_eq!(fs::read(path.parent().unwrap().join("Open Super Agent-backup-test").join(APP_ID).join("identity")).unwrap(), b"preserve");
        }
        assert_eq!(fs::read(root.join("unrelated")).unwrap(), b"keep");
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn fresh_reset_covers_both_native_identities_without_resurrecting_old_pairing() {
        let (root, mut paths) = setup();
        let old = root.join("roaming").join(LEGACY_APP_ID); fs::create_dir_all(&old).unwrap();
        fs::write(old.join("identity"), b"legacy").unwrap();
        fs::write(old.join("open-super-agent-client-installation-v1"), [4; 32]).unwrap();
        paths.push(old.clone());
        reset_with(&paths, "both", &|_, _| Ok(false), &rename).unwrap();
        assert!(!old.exists());
        let backup = root.join("roaming/Open Super Agent-backup-both");
        assert_eq!(fs::read(backup.join(LEGACY_APP_ID).join("identity")).unwrap(), b"legacy");
        assert!(backup.join(APP_ID).join("identity").exists());
        assert!(!backup.join(LEGACY_APP_ID).join("open-super-agent-client-installation-v1").exists());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn cli_service_and_live_or_unknown_lock_block_before_any_move() {
        for (name, record, reason) in [
            ("instance.lock.json", "{}", Reason::OwnerUnknown),
            ("instance.lock.json", r#"{"pid":123}"#, Reason::HostRunning),
            ("host-service.json", "{}", Reason::SharedService),
            ("update-in-progress.json", "{}", Reason::UpdatePending),
        ] {
            let (root, paths) = setup();
            let host = paths[0].join("host");
            fs::create_dir(&host).unwrap();
            fs::write(host.join(name), record).unwrap();
            assert_eq!(reset_with(&paths, "test", &|_, _| Ok(true), &rename), Err(BackupFailure::NotStarted(reason)));
            assert!(paths.iter().all(|p| p.join("identity").is_file()));
            fs::remove_dir_all(root).unwrap();
        }
    }
    #[test]
    fn dead_owner_can_reset_and_no_backup_is_overwritten() {
        let (root, paths) = setup(); let host = paths[0].join("host"); fs::create_dir(&host).unwrap();
        fs::write(host.join("instance.lock.json"), "{\"pid\":123}").unwrap();
        reset_with(&paths, "test", &|_, _| Ok(false), &rename).unwrap();
        fs::create_dir(&paths[0]).unwrap();
        assert_eq!(reset_with(&paths, "test", &|_, _| Ok(false), &rename), Err(BackupFailure::NotStarted(Reason::BackupExists)));
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn failed_second_move_rolls_first_back() {
        let (root, paths) = setup();
        fs::write(paths[0].join("open-super-agent-client-installation-v1"), [3; 32]).unwrap();
        let result = reset_with(&paths, "test", &|_, _| Ok(false), &|from, to| {
            if from == paths[1] { Err(io::Error::from(io::ErrorKind::PermissionDenied)) } else { rename(from, to) }
        });
        assert_eq!(result, Err(BackupFailure::RolledBack(Reason::MoveDenied)));
        assert_eq!(backup_exit(result, true), 153);
        assert!(paths.iter().all(|p| p.join("identity").is_file()));
        assert_eq!(fs::read(paths[0].join("open-super-agent-client-installation-v1")).unwrap(), [3; 32]);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn denied_first_move_allows_a_fresh_retry_and_preserves_existing_backups() {
        let (root, paths) = setup();
        let old = paths[0].parent().unwrap().join("Open Super Agent-backup-earlier");
        fs::create_dir(&old).unwrap();
        fs::write(old.join("keep"), b"earlier").unwrap();
        let result = reset_with(&paths, "one", &|_, _| Ok(false), &|_, _| {
            Err(io::Error::from(io::ErrorKind::PermissionDenied))
        });
        assert_eq!(result, Err(BackupFailure::NotStarted(Reason::MoveDenied)));
        assert_eq!(backup_exit(result, true), 53);
        assert!(paths.iter().all(|path| path.join("identity").is_file()));
        let retry = reset_with(&paths, "two", &|_, _| Ok(false), &rename);
        assert_eq!(retry, Ok(Backup::Completed));
        assert_eq!(backup_exit(retry, true), 0);
        assert_eq!(fs::read(old.join("keep")).unwrap(), b"earlier");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn backup_creation_race_keeps_the_existing_folder_and_moves_nothing() {
        let (root, paths) = setup();
        let existing = paths[0].parent().unwrap().join("Open Super Agent-backup-test");
        let host = paths[1].join("host");
        fs::create_dir(&host).unwrap();
        fs::write(host.join("instance.lock.json"), r#"{"pid":123}"#).unwrap();
        let result = reset_with(&paths, "test", &|_, _| {
            // The first destination has passed preflight but is not reserved yet.
            fs::create_dir(&existing).unwrap();
            fs::write(existing.join("keep"), b"existing").unwrap();
            Ok(false)
        }, &rename);
        assert_eq!(result, Err(BackupFailure::NotStarted(Reason::BackupExists)));
        assert!(paths.iter().all(|path| path.join("identity").is_file()));
        assert_eq!(fs::read(existing.join("keep")).unwrap(), b"existing");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn service_appearing_during_move_rechecks_preserves_the_reason_after_rollback() {
        let (root, paths) = setup();
        let result = reset_with(&paths, "test", &|_, _| Ok(false), &|from, to| {
            rename(from, to)?;
            if from == paths[0] {
                let host = paths[1].join("host");
                fs::create_dir(&host)?;
                fs::write(host.join("host-service.json"), "{}")?;
            }
            Ok(())
        });
        assert_eq!(result, Err(BackupFailure::RolledBack(Reason::SharedService)));
        assert_eq!(backup_exit(result, true), 140);
        assert!(paths.iter().all(|path| path.join("identity").is_file()));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn finalization_failure_is_distinct_from_a_failed_rollback() {
        let (root, paths) = setup();
        fs::create_dir(paths[1].join("open-super-agent-client-installation-v1")).unwrap();
        let result = reset_with(&paths, "test", &|_, _| Ok(false), &rename);
        assert_eq!(result, Err(BackupFailure::FinalizationIncomplete));
        assert_eq!(backup_exit(result, true), 60);
        for path in &paths {
            assert!(!path.exists());
            assert!(path.parent().unwrap().join("Open Super Agent-backup-test").join(APP_ID).join("identity").is_file());
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn legacy_and_detailed_exit_contracts_distinguish_no_data_and_safe_retries() {
        use BackupFailure::*;
        assert_eq!(backup_exit(Ok(Backup::NoData), false), 0);
        assert_eq!(backup_exit(Ok(Backup::NoData), true), 10);
        for (failure, legacy, detailed) in [
            (NotStarted(Reason::InvalidRequest), 23, 48),
            (NotStarted(Reason::OwnerUnknown), 22, 42),
            (NotStarted(Reason::UpdatePending), 21, 57),
            (RolledBack(Reason::MoveFailed), 23, 152),
            (RollbackIncomplete(Reason::MoveDenied), 24, 253),
            (FinalizationIncomplete, 24, 60),
        ] {
            assert_eq!(backup_exit(Err(failure), false), legacy);
            assert_eq!(backup_exit(Err(failure), true), detailed);
        }
    }

    #[test]
    fn full_removal_backup_cannot_restore_client_authorization() {
        let (root, paths) = setup();
        for path in &paths { fs::write(path.join("open-super-agent-client-installation-v1"), [3; 32]).unwrap(); }
        reset_with(&paths, "test", &|_, _| Ok(false), &rename).unwrap();
        for path in &paths {
            let backup = path.parent().unwrap().join("Open Super Agent-backup-test").join(APP_ID);
            assert!(backup.join("identity").is_file());
            assert!(!backup.join("open-super-agent-client-installation-v1").exists());
        }
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn failed_rollback_preserves_backup_instead_of_overwriting_new_data() {
        let (root, paths) = setup();
        let result = reset_with(&paths, "test", &|_, _| Ok(false), &|from, to| {
            if from == paths[1] {
                fs::create_dir(&paths[0]).unwrap(); fs::write(paths[0].join("new"), "new").unwrap();
                Err(io::Error::from(io::ErrorKind::PermissionDenied))
            } else { rename(from, to) }
        });
        assert_eq!(result, Err(BackupFailure::RollbackIncomplete(Reason::MoveDenied)));
        assert_eq!(backup_exit(result, true), 253);
        assert!(paths[0].join("new").is_file());
        assert!(paths[0].parent().unwrap().join("Open Super Agent-backup-test").join(APP_ID).join("identity").is_file());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn second_root_is_checked_before_first_root_is_moved() {
        let (root, paths) = setup(); let host = paths[1].join("host"); fs::create_dir(&host).unwrap();
        fs::write(host.join("host-service-refresh.json"), "{}").unwrap();
        assert_eq!(reset_with(&paths, "test", &|_, _| Ok(false), &rename), Err(BackupFailure::NotStarted(Reason::SharedService)));
        assert!(paths.iter().all(|p| p.join("identity").is_file()));
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn unreadable_process_does_not_authorize_reset() {
        let (root, paths) = setup(); let host = paths[0].join("host"); fs::create_dir(&host).unwrap();
        fs::write(host.join("instance.lock.json"), "{\"pid\":123}").unwrap();
        assert_eq!(reset_with(&paths, "test", &|_, _| Err(Reason::ProcessUnconfirmed), &rename), Err(BackupFailure::NotStarted(Reason::ProcessUnconfirmed)));
        assert!(paths.iter().all(|p| p.join("identity").is_file()));
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn process_creation_identity_is_forwarded_to_the_native_check() {
        let (root, paths) = setup(); let host = paths[0].join("host"); fs::create_dir(&host).unwrap();
        fs::write(host.join("instance.lock.json"), "{\"pid\":123,\"processBirth\":\"win32:134000000001234567\"}").unwrap();
        reset_with(&paths, "test", &|pid, birth| {
            assert_eq!(pid, 123); assert_eq!(birth, Some(134000000001234567)); Ok(false)
        }, &rename).unwrap();
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn empty_install_and_duplicate_known_folders_are_safe() {
        let (root, paths) = setup();
        reset_with(&[paths[0].clone(), paths[0].clone()], "test", &|_, _| Ok(false), &rename).unwrap();
        assert_eq!(reset_with(&[paths[0].clone()], "test", &|_, _| Ok(false), &rename), Ok(Backup::NoData));
        assert!(paths[1].join("identity").is_file());
        fs::remove_dir_all(root).unwrap();
    }
    #[cfg(unix)]
    #[test]
    fn a_link_to_another_directory_is_never_followed() {
        let (root, paths) = setup(); fs::remove_dir_all(&paths[0]).unwrap();
        std::os::unix::fs::symlink(&paths[1], &paths[0]).unwrap();
        assert_eq!(reset_with(&paths, "test", &|_, _| Ok(false), &rename), Err(BackupFailure::NotStarted(Reason::Redirected)));
        assert!(paths[1].join("identity").is_file());
        fs::remove_dir_all(root).unwrap();
    }
}
