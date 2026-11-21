import { useId, useRef, useState, useSyncExternalStore } from 'react';
import { ArrowDown, ArrowUp, ArrowUpToLine, GripVertical, MoreHorizontal, Pencil, Pin, PinOff, Trash2 } from 'lucide-react';
import { conversationFolderOrder, emptyConversationFolders, isFolderPinned, pinnedFolderOrder } from '../../src/client-protocol/conversation-folders.js';
import type { HubConnection } from './connection.js';
import { useFolderOrderDrag } from './folder-order-drag.js';
import { HostSourceBadge } from './HostSourceBadge.js';
import { t, useLocale } from './i18n.js';

export type FolderOrderRow = {
  key: string;
  folderId: string | null;
  name: string;
  hostName?: string;
  pinned: boolean;
  canEdit: boolean;
  canPin: boolean;
};

// The manager retains this draft while its create/rename/delete form is open.
export function useFolderOrder(connection: HubConnection) {
  const state = useSyncExternalStore(notify => connection.subscribe(notify), () => connection.state);
  const [base, setBase] = useState(() => state.conversationFolders ?? emptyConversationFolders());
  const [order, setOrder] = useState(() => conversationFolderOrder(base));
  const changed = JSON.stringify(order) !== JSON.stringify(conversationFolderOrder(base));
  const stale = (state.conversationFolders?.revision ?? 0) !== base.revision;
  const reload = () => {
    const latest = connection.state.conversationFolders ?? emptyConversationFolders();
    setBase(latest); setOrder(conversationFolderOrder(latest));
  };
  const acceptEdit = (revision: number) => {
    const latest = connection.state.conversationFolders ?? emptyConversationFolders();
    // A concurrent update after our receipt still needs explicit reconciliation.
    if (revision !== base.revision || latest.revision !== revision + 1) return;
    const canonical = conversationFolderOrder(latest);
    if (!changed) setOrder(canonical);
    else setOrder(previous => {
      const unpinned = canonical.filter(id => isFolderPinned(base, id) && !isFolderPinned(latest, id));
      const next = previous.filter(id => canonical.includes(id) && !unpinned.includes(id));
      const added = canonical.filter(id => !next.includes(id) && !unpinned.includes(id));
      // Keep unsaved moves; insert newly created folders before trailing Unfiled.
      next.splice(next.at(-1) === null ? next.length - 1 : next.length, 0, ...added);
      const ordered = pinnedFolderOrder(latest, next);
      // Leaving a pin at the front of the draft would undo its restored position
      // on Save. Restore that row's rank, retaining the other rows' pending moves.
      for (const id of unpinned) ordered.splice(canonical.indexOf(id), 0, id);
      return ordered;
    });
    setBase(latest);
  };
  return { base, order, setOrder, changed, stale, reload, acceptEdit };
}

export function FolderOrderList({
  rows,
  canReorder,
  showMoveTop = false,
  reorder,
  pin,
  rename,
  remove,
}: {
  rows: readonly FolderOrderRow[];
  canReorder: boolean;
  showMoveTop?: boolean;
  reorder: (nextKeys: string[]) => void;
  pin: (row: FolderOrderRow, pinned: boolean) => void;
  rename: (row: FolderOrderRow) => void;
  remove: (row: FolderOrderRow) => void;
}) {
  useLocale();
  const [expanded, setExpanded] = useState<string | undefined>();
  const [announcement, setAnnouncement] = useState('');
  const list = useRef<HTMLOListElement>(null), prefix = useId();
  const keys = rows.map(row => row.key);
  const byKey = new Map(rows.map(row => [row.key, row]));
  const hasPinned = rows.some(row => row.pinned);
  const labelOf = (row: FolderOrderRow) => row.hostName ? t('{0}（{1}）', row.name, row.hostName) : row.name;
  const announce = (next: string[], index: number) => {
    const row = byKey.get(next[index]!);
    if (row) setAnnouncement(t('「{0}」已移到第 {1} 位', labelOf(row), index + 1));
  };
  const sameSection = (a: string, b: string) => {
    const left = byKey.get(a), right = byKey.get(b);
    return !!left && !!right && left.pinned === right.pinned;
  };
  useFolderOrderDrag<string>(list, keys, canReorder, reorder, announce, sameSection, raw => raw);
  const move = (index: number, target: number) => {
    if (!canReorder || target < 0 || target >= keys.length || target === index) return;
    while (target !== index && !sameSection(keys[index]!, keys[target]!)) target += target < index ? 1 : -1;
    if (target === index) return;
    const next = [...keys]; next.splice(target, 0, ...next.splice(index, 1));
    reorder(next); announce(next, target);
  };
  return <>
    <ol ref={list} className="folder-order-list" aria-label={t('分组顺序')}>{rows.map((row, index) => {
      const label = labelOf(row), open = expanded === row.key, panelId = `${prefix}-${index}`;
      const atSectionStart = index === 0 || !sameSection(row.key, keys[index - 1]!);
      const atSectionEnd = index === rows.length - 1 || !sameSection(row.key, keys[index + 1]!);
      return <li key={row.key} data-order-id={row.key}>
        <div className="folder-manager-row">
          {row.hostName ? <div className="folder-order-identity">
            <div className="folder-order-title"><span className="folder-order-name" title={row.name}>{row.name}</span>{row.pinned && <Pin size={14} className="folder-pin" role="img" aria-label={t('已置顶')}/>}</div>
            <HostSourceBadge name={row.hostName}/>
          </div> : <><span className="folder-order-name" title={row.name}>{row.name}</span>{row.pinned && <Pin size={14} className="folder-pin" role="img" aria-label={t('已置顶')}/>}</>}
          <button type="button" className="icon-button" aria-label={t('分组操作：{0}', label)} aria-expanded={open} aria-controls={panelId} onClick={() => setExpanded(open ? undefined : row.key)}><MoreHorizontal size={18}/></button>
          <button type="button" className="icon-button folder-order-handle" data-folder-drag-handle disabled={!canReorder} aria-label={t('拖动排序：{0}', label)} onKeyDown={event => {
            const target = event.key === 'ArrowUp' ? index - 1 : event.key === 'ArrowDown' ? index + 1 : event.key === 'Home' ? 0 : event.key === 'End' ? keys.length - 1 : undefined;
            if (target !== undefined) { event.preventDefault(); move(index, target); }
          }}><GripVertical size={18}/></button>
        </div>
        {open && <div id={panelId} className="folder-manager-options">
          <button type="button" disabled={!row.canPin} aria-label={row.pinned ? t('取消置顶分组「{0}」', label) : t('置顶分组「{0}」', label)} onClick={() => pin(row, !row.pinned)}>{row.pinned ? <PinOff size={16}/> : <Pin size={16}/>}<span>{row.pinned ? t('取消置顶') : t('置顶分组')}</span></button>
          <button type="button" disabled={!canReorder || atSectionStart} aria-label={t('上移 {0}', label)} onClick={() => move(index, index - 1)}><ArrowUp size={16}/>{t('上移一位')}</button>
          <button type="button" disabled={!canReorder || atSectionEnd} aria-label={t('下移 {0}', label)} onClick={() => move(index, index + 1)}><ArrowDown size={16}/>{t('下移一位')}</button>
          {showMoveTop && <button type="button" disabled={!canReorder || atSectionStart} aria-label={hasPinned ? t('将 {0} 移到同类分组最上面', label) : t('将 {0} 移到最上面', label)} onClick={() => move(index, 0)}><ArrowUpToLine size={16}/><span>{hasPinned ? t('移到同类分组最上面') : t('移到最上面')}</span></button>}
          {row.folderId !== null && <><button type="button" disabled={!row.canEdit} aria-label={t('重命名分组「{0}」', label)} onClick={() => rename(row)}><Pencil size={16}/>{t('重命名分组')}</button>
            <button type="button" className="text-danger" disabled={!row.canEdit} aria-label={t('删除分组「{0}」', label)} onClick={() => remove(row)}><Trash2 size={16}/>{t('删除分组')}</button></>}
        </div>}
      </li>;
    })}</ol>
    <span className="folder-order-announcement" aria-live="polite">{announcement}</span>
  </>;
}

export function FolderOrderEditor({ ordering, canEdit, canReorder, canPin, pin, rename, remove }: {
  ordering: ReturnType<typeof useFolderOrder>; canEdit: boolean; canReorder: boolean; canPin: boolean;
  pin: (id: string | null, pinned: boolean) => void;
  rename: (id: string, name: string) => void; remove: (id: string) => void;
}) {
  useLocale();
  const { base, order, setOrder } = ordering;
  const rows: FolderOrderRow[] = order.map(id => ({
    key: id ?? '',
    folderId: id,
    name: id === null ? t('未分组') : base.folders.find(folder => folder.id === id)!.name,
    pinned: isFolderPinned(base, id),
    canEdit,
    canPin,
  }));
  return <FolderOrderList
    rows={rows}
    canReorder={canReorder}
    reorder={nextKeys => setOrder(nextKeys.map(key => key || null))}
    pin={(row, value) => pin(row.folderId, value)}
    rename={row => { if (row.folderId !== null) rename(row.folderId, row.name); }}
    remove={row => { if (row.folderId !== null) remove(row.folderId); }}
  />;
}
