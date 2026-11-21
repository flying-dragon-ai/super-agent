import { createRoot } from 'react-dom/client';
import type { Message } from '../../../src/client-protocol/index.js';
import { MessageContent } from '../../src/Content.js';
import type { HubConnection } from '../../src/connection.js';
import { ReplyWidthContext, type ReplyWidth } from '../../src/reply-width.js';
import '../../src/styles.css';
import '../../src/brand-theme.css';
import '../../src/palette-tokens.css';

// The same reply ID rendered for different hosts, paired devices and
// conversations, outside the App shell. `measured` records which rows were
// handed back to the (absent) virtual list.
const measured: string[] = [];
Object.assign(window, { replyWidthFixture: { measured } });
const list: ReplyWidth = { measure: row => { const name = row?.closest('[data-case]')?.getAttribute('data-case'); if (name && !measured.includes(name)) measured.push(name); } };
const connection = (host: string, device: string) => ({ identity: { hubPublicKey: host, deviceId: device }, state: { status: 'online', runScopesAvailable: true, bots: [{ id: 'alpha', name: '示例 Bot', online: true }] },
  subscribe: () => () => undefined, http: async () => ({ entries: [], next: null, expired: false, files: [] }), send: async () => undefined, stopReceipt: () => undefined }) as unknown as HubConnection;
const hosts = { 'a/1': connection('host-a', 'device-1'), 'b/1': connection('host-b', 'device-1'), 'a/2': connection('host-a', 'device-2') };
const at = Date.now();
const reply = (conversationId: string, kind: 'nativeRun' | 'scopedRun' = 'nativeRun') => ({ id: 'reply', conversationId, authorId: 'alpha', authorType: 'bot', status: 'complete', createdAt: at, blocks: [{ type: 'card', elements: [{ type: 'markdown', text: '运行状态' }, { type: 'markdown', text: '示例回复：内容只是占位。' }],
  extra: { [kind]: { version: 1, id: 'run', revision: 1, phase: 'done', startedAt: at - 9000, updatedAt: at, endedAt: at, count: 1, completed: 1, failed: 0, truncated: false }, ...(kind === 'scopedRun' ? { backgroundTask: { version: 1, origin: 'bound' } } : {}) } }] }) as unknown as Message;
const cases: { name: string; host: keyof typeof hosts; message: Message; listed?: false }[] = [
  { name: 'first', host: 'a/1', message: reply('chat-1') },
  { name: 'same reply again', host: 'a/1', message: reply('chat-1') },
  { name: 'other host', host: 'b/1', message: reply('chat-1') },
  { name: 'other device', host: 'a/2', message: reply('chat-1') },
  { name: 'other conversation', host: 'a/1', message: reply('chat-2') },
  { name: 'scoped task', host: 'a/1', message: reply('chat-1', 'scopedRun') },
  { name: 'outside the main list', host: 'a/1', message: reply('chat-1'), listed: false },
];
createRoot(document.getElementById('root')!).render(<main style={{ display: 'block', padding: 20 }}>{cases.map(entry => <section key={entry.name} data-case={entry.name} className="message-scroll" data-reply-width-room="" style={{ overflow: 'visible', padding: '0 0 12px' }}>
  <ReplyWidthContext.Provider value={entry.listed === false ? undefined : list}><article className="message bot" data-message-id={entry.message.id} style={{ position: 'relative', display: 'block' }}><MessageContent connection={hosts[entry.host]} message={entry.message}/></article></ReplyWidthContext.Provider>
</section>)}</main>);
