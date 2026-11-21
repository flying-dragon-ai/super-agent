import { attachmentFilename } from "./attachment-filename.js";
import { useEffect, useSyncExternalStore } from "react";
import { Capacitor } from "@capacitor/core";
import { androidUpdater } from "./android-updates.js";
import { androidInAppUpdates, androidUpdateStatusKnown, type AndroidUpdateState } from "./android-update-controller.js";

export function isAndroidPackage(name: string, mime = ""): boolean {
  if (!Capacitor.isNativePlatform() || Capacitor.getPlatform() !== "android") return false;
  // Use the exact saved filename: sanitizing/truncation can change its suffix.
  // Match Android's MIME lookup, including a dotless name and Unicode casing.
  const savedName = attachmentFilename(name);
  const extension = savedName.slice(savedName.lastIndexOf(".") + 1).toLowerCase();
  return extension === "apk" || mime.split(";", 1)[0]!.trim().toLowerCase() === "application/vnd.android.package-archive";
}
const unchanged: AndroidUpdateState = { phase: "initial" };
const noSubscribe = () => () => {};
const noSnapshot = () => unchanged;
let pending: Promise<void> | undefined;
/** The existing updater status identifies Play builds. Old GitHub shells return
 * configured but omit inAppUpdates. Unknown/failed status never enables an APK
 * action; Android's native attachment guards remain authoritative. */
export function useAndroidPackageOpen(name: string, mime = ""): boolean {
  const apk = isAndroidPackage(name, mime);
  const state = useSyncExternalStore(apk ? androidUpdater.subscribe : noSubscribe, apk ? androidUpdater.snapshot : noSnapshot);
  useEffect(() => {
    if (!apk || androidUpdateStatusKnown(androidUpdater.snapshot())) return;
    pending ??= androidUpdater.refresh().finally(() => { pending = undefined; });
  }, [apk]);
  return !apk || androidUpdateStatusKnown(state) && androidInAppUpdates(state);
}
