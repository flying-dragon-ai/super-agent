import { useAndroidPackageOpen } from "./android-package-actions.js";
import { Download, ExternalLink, Share2, X } from "lucide-react";
import { attachmentSaveLabel, canOpenAttachmentExternally } from "./attachment-export.js";
import { t } from "./i18n.js";
import type { RefObject } from "react";

export function AttachmentPreviewHeader({ name, mime, busy, save, share, external, close, headerRef }: {
  name: string; mime?: string; busy?: boolean; save: () => void; share: () => void; external: () => void; close: () => void;
  headerRef?: RefObject<HTMLElement | null>;
}) {
  const allowPackageOpen = useAndroidPackageOpen(name, mime);
  if (!canOpenAttachmentExternally()) return <header ref={headerRef}><strong title={name}>{name}</strong><button disabled={busy} onClick={save}>{attachmentSaveLabel()}</button><button onClick={close}>{t("关闭")}</button></header>;
  return <header ref={headerRef} className="native-file-header"><strong title={name}>{name}</strong><button className="native-file-close" aria-label={t("关闭")} title={t("关闭")} onClick={close}><X size={20}/></button>
    <div className="native-file-actions">
      <button disabled={busy} onClick={save}><Download size={16}/><span>{attachmentSaveLabel()}</span></button>
      <button disabled={busy} aria-label={t("分享附件")} onClick={share}><Share2 size={16}/><span>{t("分享")}</span></button>
      {allowPackageOpen && <button disabled={busy} aria-label={t("用其他应用打开")} onClick={external}><ExternalLink size={16}/><span>{t("其他应用")}</span></button>}
    </div>
  </header>;
}
