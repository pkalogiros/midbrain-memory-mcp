// NanoClaw v2 mailbox. Reuse the pinned checkout's schemas; the host writes
// inbound, the runner writes outbound. Every access opens/closes its DB so
// Docker Desktop's shared mounts cannot leave us reading a cached snapshot.
import path from 'node:path';
import { readFileSync } from 'node:fs';

async function database(file, readOnly = false) {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(file, { readOnly });
  db.exec('PRAGMA busy_timeout=5000; PRAGMA mmap_size=0;');
  return db;
}

export async function createMailbox(dir, source, sessionId) {
  // This source file contains only exported SQL constants in the pinned
  // revision. Import from a data URL to avoid requiring a TS loader on Node.
  const text = readFileSync(path.join(source, 'src/mailbox/sqlite/schema.ts'), 'utf8');
  const schema = await import('data:text/javascript;base64,' + Buffer.from(text).toString('base64'));
  for (const kind of ['inbound', 'outbound']) {
    const db = await database(path.join(dir, kind + '.db'));
    try {
      db.exec('PRAGMA journal_mode=DELETE;');
      db.exec(schema[kind.toUpperCase() + '_SCHEMA']);
      if (kind === 'inbound') {
        db.prepare('INSERT INTO session_routing(id,channel_type,platform_id,thread_id) VALUES(1,?,?,?)').run('cli', 'harness', sessionId);
        db.prepare('INSERT INTO destinations(name,display_name,type,channel_type,platform_id,agent_group_id) VALUES(?,?,?,?,?,?)').run('harness', 'Harness', 'channel', 'cli', 'harness', null);
      }
    } finally { db.close(); }
  }
}

export async function enqueue(dir, id, sessionId, prompt) {
  const db = await database(path.join(dir, 'inbound.db'));
  try {
    const seq = Number(db.prepare('SELECT COALESCE(MAX(seq),0)+2 AS n FROM messages_in').get().n);
    db.prepare('INSERT INTO messages_in(id,seq,kind,timestamp,status,trigger,platform_id,channel_type,thread_id,content,on_wake) VALUES(?,?,?,?,?,?,?,?,?,?,0)').run(
      id, seq, 'chat', new Date().toISOString(), 'pending', 1, 'harness', 'cli', sessionId,
      JSON.stringify({ sender: 'Harness', senderId: 'harness', text: prompt, isFromMe: false }),
    );
  } finally { db.close(); }
}

export async function readMailbox(dir, messageId) {
  const db = await database(path.join(dir, 'outbound.db'), true);
  try {
    return {
      ack: db.prepare('SELECT status FROM processing_ack WHERE message_id=?').get(messageId)?.status || null,
      messages: db.prepare('SELECT * FROM messages_out WHERE in_reply_to=? ORDER BY seq').all(messageId),
      continuation: db.prepare("SELECT value FROM session_state WHERE key='continuation:claude'").get()?.value || null,
    };
  } finally { db.close(); }
}
