const { Pool } = require('pg');
const sqlite3 = require('sqlite3');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { database: dbConfig } = require('./env');
const logger = require('../utils/logger');

// Bestimme Treiber: Nutze Postgres, falls DATABASE_URL gesetzt ist und mit "postgres" beginnt.
// Andernfalls weichen wir auf SQLite aus.
const isPostgres = !!(dbConfig.url && dbConfig.url.startsWith('postgres'));

let pool = null;
let db = null;
let hasPgVector = true;

if (isPostgres) {
  logger.info('[DB Setup] Verwende PostgreSQL-Datenbank.');
  pool = new Pool({
    connectionString: dbConfig.url,
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  });

  pool.on('error', (err) => {
    logger.error(`[DB Pool Error] ${err.message}`);
  });
} else {
  logger.info('[DB Setup] Keine DATABASE_URL gefunden. Fallback auf lokale SQLite-Datenbank.');
  const dbPath = path.join(__dirname, '../../data/sqlite.db');
  const dbDir = path.dirname(dbPath);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }
  
  db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
      logger.error(`[SQLite Open Error] ${err.message}`);
    } else {
      logger.info(`[DB Setup] SQLite-Datenbank geöffnet unter: ${dbPath}`);
    }
  });
}

// ==============================================================================
// Schemadefinitionen und Initialisierung
// ==============================================================================

const SQLITE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    system_prompt TEXT NOT NULL DEFAULT 'Du bist ein hilfreicher Assistent fuer eSIM-Beratung.',
    negative_prompt TEXT DEFAULT '',
    welcome_message TEXT DEFAULT 'Hallo! 👋 Wie kann ich dir helfen?',
    manual_msg_template TEXT DEFAULT 'Ein Mitarbeiter wird gleich uebernehmen.',
    ai_model TEXT DEFAULT 'deepseek-v4-flash',
    ai_max_tokens INTEGER DEFAULT 1024,
    ai_temperature REAL DEFAULT 0.5,
    ai_max_input_tokens INTEGER DEFAULT 4096,
    rag_threshold REAL DEFAULT 0.3,
    rag_match_count INTEGER DEFAULT 8,
    max_history_msgs INTEGER DEFAULT 4,
    summary_interval INTEGER DEFAULT 5,
    sellauth_api_key TEXT DEFAULT '',
    sellauth_shop_id TEXT DEFAULT '',
    sellauth_shop_url TEXT DEFAULT '',
    admin_telegram_id TEXT DEFAULT '',
    notify_new_chat INTEGER DEFAULT 1,
    notify_every_msg INTEGER DEFAULT 0,
    webhook_url TEXT DEFAULT '',
    widget_powered_by TEXT DEFAULT 'Powered by ValueShop25 AI',
    abuse_max_msgs_per_hour INTEGER DEFAULT 30,
    abuse_auto_ban_flags INTEGER DEFAULT 3,
    abuse_min_msg_length INTEGER DEFAULT 1,
    coupon_enabled INTEGER DEFAULT 0,
    coupon_discount INTEGER DEFAULT 10,
    coupon_type TEXT DEFAULT 'percentage',
    coupon_description TEXT DEFAULT '10% Rabatt',
    coupon_max_uses INTEGER DEFAULT NULL,
    coupon_schedule_hour INTEGER DEFAULT 0,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  INSERT OR IGNORE INTO settings (id) VALUES (1);

  CREATE TABLE IF NOT EXISTS chats (
    id TEXT PRIMARY KEY,
    platform TEXT NOT NULL DEFAULT 'telegram',
    status TEXT DEFAULT 'ki',
    is_manual_mode INTEGER DEFAULT 0,
    metadata TEXT DEFAULT '{}',
    last_message TEXT,
    last_message_role TEXT DEFAULT 'user',
    message_count INTEGER DEFAULT 0,
    first_name TEXT,
    username TEXT,
    chat_summary TEXT,
    summary_msg_count INTEGER DEFAULT 0,
    last_summarized_at TEXT,
    flag_count INTEGER DEFAULT 0,
    auto_muted INTEGER DEFAULT 0,
    mute_reason TEXT,
    msg_count_1h INTEGER DEFAULT 0,
    last_msg_burst TEXT,
    visitor_ip TEXT,
    visitor_id TEXT,
    manual_mode_started_at TEXT,
    manual_mode_ended_at TEXT,
    is_learning_session INTEGER DEFAULT 0,
    mute_until TEXT,
    spam_warn_count INTEGER DEFAULT 0,
    last_spam_warn_at TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    chat_id TEXT REFERENCES chats(id) ON DELETE CASCADE,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    prompt_tokens INTEGER DEFAULT 0,
    completion_tokens INTEGER DEFAULT 0,
    embedding_tokens INTEGER DEFAULT 0,
    is_manual INTEGER DEFAULT 0,
    is_handover INTEGER DEFAULT 0,
    classification TEXT DEFAULT NULL,
    rag_hits TEXT DEFAULT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS knowledge_categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    description TEXT,
    parent_id INTEGER REFERENCES knowledge_categories(id) ON DELETE SET NULL,
    display_order INTEGER DEFAULT 0,
    icon TEXT,
    color TEXT DEFAULT '#3b82f6',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS knowledge_base (
    id TEXT PRIMARY KEY,
    category_id INTEGER REFERENCES knowledge_categories(id) ON DELETE SET NULL,
    title TEXT,
    content TEXT NOT NULL,
    source_url TEXT,
    source_type TEXT DEFAULT 'manual',
    source TEXT,
    embedding TEXT,
    is_active INTEGER DEFAULT 1,
    views INTEGER DEFAULT 0,
    last_synced TEXT,
    metadata TEXT DEFAULT '{}',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  INSERT OR IGNORE INTO knowledge_categories (id, name, icon, color) VALUES
    (1, 'Travel eSIM',          '✈️',  '#3b82f6'),
    (2, 'Unlimited Eco eSIM',   '🌿',  '#10b981'),
    (3, 'Unlimited Pro eSIM',   '⚡',  '#8b5cf6'),
    (4, 'FAQ & Anleitung',      '❓',  '#64748b'),
    (5, 'Technischer Support',  '🛠️', '#94a3b8');

  CREATE TABLE IF NOT EXISTS learning_queue (
    id TEXT PRIMARY KEY,
    chat_id TEXT,
    question TEXT NOT NULL,
    context TEXT,
    status TEXT DEFAULT 'pending',
    resolved_answer TEXT,
    resolved_at TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS blacklist (
    id TEXT PRIMARY KEY,
    chat_id TEXT,
    visitor_ip TEXT,
    reason TEXT,
    banned_by TEXT,
    banned_at TEXT DEFAULT CURRENT_TIMESTAMP,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS user_flags (
    id TEXT PRIMARY KEY,
    chat_id TEXT,
    flag_type TEXT NOT NULL,
    details TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS widget_visitors (
    chat_id TEXT PRIMARY KEY,
    ip TEXT,
    fingerprint TEXT,
    user_agent TEXT,
    first_seen TEXT DEFAULT CURRENT_TIMESTAMP,
    last_seen TEXT DEFAULT CURRENT_TIMESTAMP,
    metadata TEXT DEFAULT '{}',
    ip_hash TEXT
  );

  CREATE TABLE IF NOT EXISTS visitor_sessions (
    id TEXT PRIMARY KEY,
    chat_id TEXT,
    started_at TEXT DEFAULT CURRENT_TIMESTAMP,
    last_seen TEXT DEFAULT CURRENT_TIMESTAMP,
    is_active INTEGER DEFAULT 1,
    entry_page TEXT,
    last_page TEXT,
    page_count INTEGER DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS visitor_activities (
    id TEXT PRIMARY KEY,
    chat_id TEXT,
    activity_type TEXT,
    page_url TEXT,
    page_title TEXT,
    activity TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS daily_coupons (
    id TEXT PRIMARY KEY,
    code TEXT NOT NULL UNIQUE,
    discount_value INTEGER,
    discount_type TEXT DEFAULT 'percentage',
    description TEXT,
    active_from TEXT DEFAULT CURRENT_TIMESTAMP,
    active_until TEXT,
    max_uses INTEGER,
    uses INTEGER DEFAULT 0,
    is_active INTEGER DEFAULT 1,
    sellauth_id TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS coupon_schedule (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    weekday INTEGER NOT NULL UNIQUE CHECK (weekday BETWEEN 0 AND 6),
    enabled INTEGER DEFAULT 1,
    discount INTEGER DEFAULT 10,
    type TEXT DEFAULT 'percentage',
    description TEXT,
    max_uses INTEGER,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  INSERT OR IGNORE INTO coupon_schedule (weekday, enabled, discount, type, description) VALUES
    (0, 1, 10, 'percentage', ''),
    (1, 1, 10, 'percentage', ''),
    (2, 1, 10, 'percentage', ''),
    (3, 1, 10, 'percentage', ''),
    (4, 1, 10, 'percentage', ''),
    (5, 1, 10, 'percentage', ''),
    (6, 1, 10, 'percentage', '');

  CREATE TABLE IF NOT EXISTS admin_subscriptions (
    id TEXT PRIMARY KEY,
    endpoint TEXT NOT NULL UNIQUE,
    subscription_data TEXT NOT NULL,
    device_label TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS integration_logs (
    id TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    event_type TEXT,
    payload TEXT,
    status TEXT,
    error TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS sync_jobs (
    id TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    status TEXT DEFAULT 'pending',
    progress INTEGER DEFAULT 0,
    total INTEGER,
    result TEXT,
    error TEXT,
    started_at TEXT DEFAULT CURRENT_TIMESTAMP,
    completed_at TEXT
  );

  CREATE TABLE IF NOT EXISTS discovered_links (
    id TEXT PRIMARY KEY,
    url TEXT NOT NULL UNIQUE,
    title TEXT,
    status TEXT DEFAULT 'pending',
    category_id INTEGER REFERENCES knowledge_categories(id) ON DELETE SET NULL,
    discovered_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS user_feedbacks (
    id TEXT PRIMARY KEY,
    channel_id TEXT,
    target_user_id TEXT,
    target_username TEXT,
    feedback_type TEXT,
    status TEXT DEFAULT 'pending',
    has_proofs INTEGER DEFAULT 0,
    proof_count INTEGER DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS feedback_proofs (
    id TEXT PRIMARY KEY,
    feedback_id TEXT REFERENCES user_feedbacks(id) ON DELETE CASCADE,
    proof_url TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
`;

// Entfernt SQL-Kommentare (Zeilen, die mit -- beginnen, sowie Inline-Kommentare) aus dem Skript.
function stripSqlComments(sql) {
  return sql.split('\n').map(line => {
    const trimmed = line.trim();
    if (trimmed.startsWith('--')) {
      return '';
    }
    const idx = line.indexOf('--');
    if (idx >= 0) {
      return line.substring(0, idx);
    }
    return line;
  }).join('\n');
}

// Hilfsfunktion zum Aufteilen eines SQL-Skripts in einzelne Anweisungen.
// Beachtet $$-Blöcke (z. B. für PostgreSQL-Funktionen), damit Semicolons darin nicht fälschlich trennen.
function splitSqlStatements(sql) {
  const cleanSql = stripSqlComments(sql);
  const statements = [];
  let current = '';
  let inDollarQuote = false;
  
  for (let i = 0; i < cleanSql.length; i++) {
    const char = cleanSql[i];
    const nextChar = cleanSql[i + 1];
    
    if (char === '$' && nextChar === '$') {
      inDollarQuote = !inDollarQuote;
      current += '$$';
      i++; // Überspringe das zweite '$'
      continue;
    }
    
    if (char === ';' && !inDollarQuote) {
      statements.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  if (current.trim()) {
    statements.push(current.trim());
  }
  return statements.filter(stmt => stmt.trim().length > 0);
}

// Führt die Schema-Initialisierung beim Starten aus
async function initializeDatabase() {
  if (isPostgres) {
    try {
      // Prüfe, ob pgvector in Postgres unterstützt wird
      try {
        const checkVector = await pool.query("SELECT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'vector');");
        hasPgVector = checkVector.rows[0].exists;
      } catch (e) {
        hasPgVector = false;
      }
      logger.info(`[DB Setup] Postgres pgvector Support: ${hasPgVector ? 'JA' : 'NEIN'}`);

      // Prüfe, ob settings bereits existiert (um festzustellen, ob es eine Neuinstallation ist)
      let isFreshInstall = false;
      try {
        const checkSettings = await pool.query("SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'settings');");
        isFreshInstall = !checkSettings.rows[0].exists;
      } catch (e) {
        isFreshInstall = true;
      }

      if (isFreshInstall) {
        logger.info('[DB Init] Postgres: Führe Erst-Schema-Initialisierung aus...');
        const schemaPath = path.join(__dirname, '../../supabase/schema_full_v2.sql');
        if (fs.existsSync(schemaPath)) {
          let sql = fs.readFileSync(schemaPath, 'utf8');
          
          // Wenn pgvector fehlt, passen wir das Schema für Vektoren an (speichern als Text)
          if (!hasPgVector) {
            logger.info('[DB Init] Postgres: Passe Schema für Betrieb OHNE pgvector an...');
            sql = sql.replace(/embedding\s+vector\(\d+\)/gi, 'embedding TEXT');
          }

          const statements = splitSqlStatements(sql);
          for (const stmt of statements) {
            // Überspringe Statements, die pgvector erfordern
            if (!hasPgVector) {
              if (stmt.toUpperCase().includes('USING IVFFLAT') || 
                  stmt.toUpperCase().includes('FUNCTION MATCH_KNOWLEDGE')) {
                logger.info(`[DB Init] Postgres: Überspringe pgvector-abhängiges Statement: ${stmt.substring(0, 50)}...`);
                continue;
              }
            }

            try {
              await pool.query(stmt);
            } catch (stmtErr) {
              if (stmt.toUpperCase().includes('CREATE EXTENSION')) {
                logger.warn(`[DB Init] Postgres: Extension-Erstellung ignoriert: ${stmtErr.message}`);
              } else {
                logger.error(`[DB Init] Postgres-Fehler bei SQL-Statement: ${stmt.substring(0, 150)}...`);
                throw stmtErr;
              }
            }
          }
          logger.info('[DB Init] Postgres: Schema-Initialisierung erfolgreich abgeschlossen.');
        }
      } else {
        logger.info('[DB Init] Postgres: Bereits initialisiert. Überspringe Erst-Schema.');
      }

      // Migrations-Runner
      logger.info('[DB Init] Postgres: Überprüfe Datenbank-Migrationen...');
      await pool.query(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          version VARCHAR(255) PRIMARY KEY,
          executed_at TIMESTAMPTZ DEFAULT NOW()
        );
      `);

      const supabaseDir = path.join(__dirname, '../../supabase');
      if (fs.existsSync(supabaseDir)) {
        const files = fs.readdirSync(supabaseDir);
        const migrations = files
          .filter(f => f.startsWith('MIGRATION_') && f.endsWith('.sql'))
          .sort((a, b) => {
            const numA = a.match(/\d+/g).map(Number);
            const numB = b.match(/\d+/g).map(Number);
            for (let i = 0; i < Math.max(numA.length, numB.length); i++) {
              const valA = numA[i] || 0;
              const valB = numB[i] || 0;
              if (valA !== valB) return valA - valB;
            }
            return a.localeCompare(b);
          });

        for (const migrationFile of migrations) {
          const check = await pool.query('SELECT 1 FROM schema_migrations WHERE version = $1', [migrationFile]);
          if (check.rows.length === 0) {
            if (isFreshInstall) {
              // Bei einer Neuinstallation ist das Schema bereits auf dem neuesten Stand (2.0.23),
              // wir markieren die Migration einfach als ausgeführt.
              await pool.query('INSERT INTO schema_migrations (version) VALUES ($1)', [migrationFile]);
              logger.info(`[DB Init] Postgres: Markiere Migration ${migrationFile} als ausgeführt (Neuinstallation).`);
            } else {
              logger.info(`[DB Init] Postgres: Führe Migration ${migrationFile} aus...`);
              const migrationPath = path.join(supabaseDir, migrationFile);
              let sql = fs.readFileSync(migrationPath, 'utf8');
              const statements = splitSqlStatements(sql);
              for (const stmt of statements) {
                try {
                  await pool.query(stmt);
                } catch (stmtErr) {
                  logger.error(`[DB Init] Postgres-Fehler bei Migration ${migrationFile} in Statement: ${stmt.substring(0, 100)}... | Msg: ${stmtErr.message}`);
                  throw stmtErr;
                }
              }
              await pool.query('INSERT INTO schema_migrations (version) VALUES ($1)', [migrationFile]);
              logger.info(`[DB Init] Postgres: Migration ${migrationFile} erfolgreich abgeschlossen.`);
            }
          }
        }
      }
    } catch (err) {
      logger.error(`[DB Init] Postgres-Fehler: ${err.message}`);
    }
  } else {
    // SQLite Initialisierung
    return new Promise(async (resolve) => {
      logger.info('[DB Init] SQLite: Führe Schema-Initialisierung aus...');
      const statements = splitSqlStatements(SQLITE_SCHEMA);
      
      for (const stmt of statements) {
        await new Promise((resStmt) => {
          db.run(stmt, (stmtErr) => {
            if (stmtErr) logger.error(`[DB Init] SQLite Statement Error: ${stmtErr.message} | SQL: ${stmt}`);
            resStmt();
          });
        });
      }
      logger.info('[DB Init] SQLite: Schema-Initialisierung abgeschlossen.');
      resolve();
    });
  }
}

// Führe Initialisierung im Hintergrund aus
initializeDatabase().catch(err => {
  logger.error(`[DB Init Background] Fehler: ${err.message}`);
});

// ==============================================================================
// Adapter-Helfer
// ==============================================================================

// Konvertiert arrays / objects für den jeweiligen Treiber
const formatValueForDriver = (val) => {
  if (val === undefined) return null;
  if (isPostgres) {
    if (Array.isArray(val) && val.length > 0 && typeof val[0] === 'number') {
      if (hasPgVector) {
        return '[' + val.join(',') + ']'; // pgvector format
      } else {
        return JSON.stringify(val); // Text format (JSON array)
      }
    }
    return val;
  } else {
    // SQLite Modus: Speichere Arrays und Objekte als JSON-String
    if (val !== null && (typeof val === 'object' || Array.isArray(val))) {
      return JSON.stringify(val);
    }
    return val;
  }
};

// Parst zurückerhaltene JSON-Felder in SQLite wieder zu JavaScript Objekten
const parseRow = (row) => {
  if (!row) return row;
  const parsed = { ...row };
  for (const [key, val] of Object.entries(parsed)) {
    if (typeof val === 'string') {
      const trimmed = val.trim();
      if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
        try {
          parsed[key] = JSON.parse(val);
        } catch (e) {
          // Behalte als String
        }
      }
    }
  }
  return parsed;
};

// ==============================================================================
// QueryBuilder Kompatibilitätsklasse
// ==============================================================================

class QueryBuilder {
  constructor(table) {
    this.table = table;
    this.op = 'select'; // select, insert, update, upsert, delete
    this.selectFields = '*';
    this.countOption = null;
    this.isHead = false;
    this.conditions = [];
    this.orderFields = [];
    this.limitVal = null;
    this.offsetVal = null;
    this.singleRow = false;
    this.maybeSingleRow = false;
    this.insertData = null;
    this.updateData = null;
    this.upsertData = null;
    this.onConflictCol = null;
  }

  select(fields = '*', options = {}) {
    if (this.op === 'insert' || this.op === 'update' || this.op === 'upsert' || this.op === 'delete') {
      return this;
    }
    this.op = 'select';
    this.selectFields = fields || '*';
    this.countOption = options.count || null;
    this.isHead = options.head || false;
    return this;
  }

  eq(col, val) {
    this.conditions.push({ col, op: '=', val });
    return this;
  }

  neq(col, val) {
    this.conditions.push({ col, op: '!=', val });
    return this;
  }

  gt(col, val) {
    this.conditions.push({ col, op: '>', val });
    return this;
  }

  gte(col, val) {
    this.conditions.push({ col, op: '>=', val });
    return this;
  }

  lt(col, val) {
    this.conditions.push({ col, op: '<', val });
    return this;
  }

  lte(col, val) {
    this.conditions.push({ col, op: '<=', val });
    return this;
  }

  is(col, val) {
    this.conditions.push({ col, op: 'IS', val });
    return this;
  }

  not(col, op, val) {
    this.conditions.push({ col, op: 'NOT', subop: op, val });
    return this;
  }

  in(col, arr) {
    this.conditions.push({ col, op: 'IN', val: arr });
    return this;
  }

  or(conditionsString) {
    this.conditions.push({ op: 'OR', raw: conditionsString });
    return this;
  }

  ilike(col, val) {
    this.conditions.push({ col, op: 'ILIKE', val });
    return this;
  }

  order(col, options = {}) {
    const direction = options.ascending === false ? 'DESC' : 'ASC';
    this.orderFields.push(`"${col}" ${direction}`);
    return this;
  }

  limit(val) {
    this.limitVal = parseInt(val, 10);
    return this;
  }

  range(start, end) {
    this.limitVal = parseInt(end, 10) - parseInt(start, 10) + 1;
    this.offsetVal = parseInt(start, 10);
    return this;
  }

  single() {
    this.singleRow = true;
    return this;
  }

  maybeSingle() {
    this.maybeSingleRow = true;
    return this;
  }

  insert(data) {
    this.op = 'insert';
    this.insertData = Array.isArray(data) ? data : [data];
    return this;
  }

  update(data) {
    this.op = 'update';
    this.updateData = data;
    return this;
  }

  upsert(data, options = {}) {
    this.op = 'upsert';
    this.upsertData = Array.isArray(data) ? data : [data];
    this.onConflictCol = options.onConflict || null;
    return this;
  }

  delete() {
    this.op = 'delete';
    return this;
  }

  then(onfulfilled, onrejected) {
    return this.execute().then(onfulfilled, onrejected);
  }

  async execute() {
    let sql = '';
    const params = [];

    // Platzhalter für Postgres ($1, $2) vs. SQLite (?)
    const placeholderFunc = isPostgres ? (idx) => `$${idx}` : () => '?';

    const compileCondition = (cond) => {
      if (cond.op === 'OR') {
        const orParts = cond.raw.split(',');
        const compiledParts = [];
        for (const part of orParts) {
          const subParts = part.trim().split('.');
          if (subParts.length >= 3) {
            const col = subParts[0];
            const op = subParts[1];
            let val = subParts.slice(2).join('.');
            
            if (val === 'null') val = null;
            else if (val === 'true') val = true;
            else if (val === 'false') val = false;

            if (op === 'eq') {
              if (val === null) {
                compiledParts.push(`"${col}" IS NULL`);
              } else {
                params.push(formatValueForDriver(val));
                compiledParts.push(`"${col}" = ${placeholderFunc(params.length)}`);
              }
            } else if (op === 'neq') {
              if (val === null) {
                compiledParts.push(`"${col}" IS NOT NULL`);
              } else {
                params.push(formatValueForDriver(val));
                compiledParts.push(`"${col}" != ${placeholderFunc(params.length)}`);
              }
            }
          }
        }
        return compiledParts.length > 0 ? `(${compiledParts.join(' OR ')})` : 'TRUE';
      }

      const { col, op, val, subop } = cond;
      if (op === '=') {
        if (val === null) return `"${col}" IS NULL`;
        params.push(formatValueForDriver(val));
        return `"${col}" = ${placeholderFunc(params.length)}`;
      }
      if (op === '!=') {
        if (val === null) return `"${col}" IS NOT NULL`;
        params.push(formatValueForDriver(val));
        return `"${col}" != ${placeholderFunc(params.length)}`;
      }
      if (op === '>') {
        params.push(formatValueForDriver(val));
        return `"${col}" > ${placeholderFunc(params.length)}`;
      }
      if (op === '>=') {
        params.push(formatValueForDriver(val));
        return `"${col}" >= ${placeholderFunc(params.length)}`;
      }
      if (op === '<') {
        params.push(formatValueForDriver(val));
        return `"${col}" < ${placeholderFunc(params.length)}`;
      }
      if (op === '<=') {
        params.push(formatValueForDriver(val));
        return `"${col}" <= ${placeholderFunc(params.length)}`;
      }
      if (op === 'IS') {
        if (val === null) return `"${col}" IS NULL`;
        params.push(formatValueForDriver(val));
        return `"${col}" IS ${placeholderFunc(params.length)}`;
      }
      if (op === 'NOT') {
        if (subop === 'is' && val === null) return `"${col}" IS NOT NULL`;
        params.push(formatValueForDriver(val));
        return `NOT ("${col}" ${subop} ${placeholderFunc(params.length)})`;
      }
      if (op === 'IN') {
        if (!Array.isArray(val) || val.length === 0) return 'FALSE';
        const placeholders = val.map(v => {
          params.push(formatValueForDriver(v));
          return placeholderFunc(params.length);
        }).join(', ');
        return `"${col}" IN (${placeholders})`;
      }
      if (op === 'ILIKE') {
        params.push(formatValueForDriver(val));
        const likeOp = isPostgres ? 'ILIKE' : 'LIKE';
        return `"${col}" ${likeOp} ${placeholderFunc(params.length)}`;
      }
      return 'TRUE';
    };

    let countEnabled = false;

    if (this.op === 'select') {
      let fieldsSql = this.selectFields;
      // Postgres COUNT(*) OVER() Trick
      if (isPostgres && this.countOption === 'exact' && !this.isHead) {
        fieldsSql = `${this.selectFields}, COUNT(*) OVER() AS __full_count`;
        countEnabled = true;
      } else if (isPostgres && this.isHead) {
        fieldsSql = 'COUNT(*) AS __full_count';
        countEnabled = true;
      }

      sql = `SELECT ${fieldsSql} FROM "${this.table}"`;
      const compiledConds = this.conditions.map(compileCondition);
      if (compiledConds.length > 0) {
        sql += ` WHERE ${compiledConds.join(' AND ')}`;
      }
      if (this.orderFields.length > 0) {
        sql += ` ORDER BY ${this.orderFields.join(', ')}`;
      }
      if (this.limitVal !== null) {
        sql += ` LIMIT ${this.limitVal}`;
      }
      if (this.offsetVal !== null) {
        sql += ` OFFSET ${this.offsetVal}`;
      }
    } 
    else if (this.op === 'insert') {
      if (!this.insertData || this.insertData.length === 0) {
        return { data: [], error: null, count: 0 };
      }
      
      // Auto-generiere UUIDs in JavaScript falls SQLite und Feld id leer ist
      if (!isPostgres) {
        const uuidTables = ['messages', 'knowledge_base', 'learning_queue', 'blacklist', 'user_flags', 'visitor_sessions', 'visitor_activities', 'daily_coupons', 'admin_subscriptions', 'integration_logs', 'sync_jobs', 'discovered_links', 'user_feedbacks', 'feedback_proofs'];
        for (const row of this.insertData) {
          if (!row.id && uuidTables.includes(this.table)) {
            row.id = crypto.randomUUID();
          }
        }
      }

      const keys = Array.from(new Set(this.insertData.reduce((acc, row) => acc.concat(Object.keys(row)), [])));
      const columns = keys.map(k => `"${k}"`).join(', ');
      
      const valuePlaceholders = [];
      for (const row of this.insertData) {
        const rowPlaceholders = [];
        for (const key of keys) {
          const val = row[key] !== undefined ? row[key] : null;
          params.push(formatValueForDriver(val));
          rowPlaceholders.push(placeholderFunc(params.length));
        }
        valuePlaceholders.push(`(${rowPlaceholders.join(', ')})`);
      }

      sql = `INSERT INTO "${this.table}" (${columns}) VALUES ${valuePlaceholders.join(', ')} RETURNING *`;
    } 
    else if (this.op === 'update') {
      if (!this.updateData || Object.keys(this.updateData).length === 0) {
        return { data: [], error: null, count: 0 };
      }
      const setClauses = [];
      for (const [key, val] of Object.entries(this.updateData)) {
        params.push(formatValueForDriver(val));
        setClauses.push(`"${key}" = ${placeholderFunc(params.length)}`);
      }

      sql = `UPDATE "${this.table}" SET ${setClauses.join(', ')}`;
      const compiledConds = this.conditions.map(compileCondition);
      if (compiledConds.length > 0) {
        sql += ` WHERE ${compiledConds.join(' AND ')}`;
      }
      sql += ' RETURNING *';
    } 
    else if (this.op === 'upsert') {
      if (!this.upsertData || this.upsertData.length === 0) {
        return { data: [], error: null, count: 0 };
      }
      const keys = Array.from(new Set(this.upsertData.reduce((acc, row) => acc.concat(Object.keys(row)), [])));
      const columns = keys.map(k => `"${k}"`).join(', ');
      
      const valuePlaceholders = [];
      for (const row of this.upsertData) {
        const rowPlaceholders = [];
        for (const key of keys) {
          const val = row[key] !== undefined ? row[key] : null;
          params.push(formatValueForDriver(val));
          rowPlaceholders.push(placeholderFunc(params.length));
        }
        valuePlaceholders.push(`(${rowPlaceholders.join(', ')})`);
      }

      const conflictTarget = this.onConflictCol || (this.table === 'widget_visitors' ? 'chat_id' : 'id');
      const updateKeys = keys.filter(k => k !== conflictTarget);
      const doUpdateSet = updateKeys.map(k => `"${k}" = EXCLUDED."${k}"`).join(', ');

      sql = `INSERT INTO "${this.table}" (${columns}) VALUES ${valuePlaceholders.join(', ')}`;
      if (doUpdateSet) {
        sql += ` ON CONFLICT ("${conflictTarget}") DO UPDATE SET ${doUpdateSet}`;
      } else {
        sql += ` ON CONFLICT ("${conflictTarget}") DO NOTHING`;
      }
      sql += ' RETURNING *';
    } 
    else if (this.op === 'delete') {
      sql = `DELETE FROM "${this.table}"`;
      const compiledConds = this.conditions.map(compileCondition);
      if (compiledConds.length > 0) {
        sql += ` WHERE ${compiledConds.join(' AND ')}`;
      }
      sql += ' RETURNING *';
    }

    try {
      let data = [];
      let count = null;

      if (isPostgres) {
        const result = await pool.query(sql, params);
        data = result.rows;
        if (!hasPgVector) {
          data = data.map(parseRow);
        }

        if (countEnabled && data.length > 0) {
          if (this.isHead) {
            count = parseInt(data[0].__full_count, 10);
            data = [];
          } else {
            count = parseInt(data[0].__full_count, 10);
            data.forEach(row => delete row.__full_count);
          }
        } else if (countEnabled) {
          count = 0;
        }
      } else {
        // SQLite Modus
        data = await new Promise((resolve, reject) => {
          db.all(sql, params, (err, rows) => {
            if (err) reject(err);
            else resolve(rows || []);
          });
        });
        // Parse JSON-Felder zurück zu JS-Objekten
        data = data.map(parseRow);

        // SQLite separates Count Query (da window functions COUNT(*) OVER() nicht immer performant sind)
        if (this.countOption === 'exact' || this.isHead) {
          const countSql = `SELECT COUNT(*) AS total FROM "${this.table}"` + 
            (this.conditions.length > 0 ? ` WHERE ${this.conditions.map(compileCondition).join(' AND ')}` : '');
          
          const countRes = await new Promise((resolve, reject) => {
            db.get(countSql, params, (err, row) => {
              if (err) reject(err);
              else resolve(row ? row.total : 0);
            });
          });
          count = countRes;
          if (this.isHead) data = [];
        }
      }

      if (this.singleRow) {
        if (data.length === 0) {
          return { data: null, error: { message: 'JSON object requested, multiple (or no) rows returned', code: 'PGRST116' }, count };
        }
        data = data[0];
      } else if (this.maybeSingleRow) {
        data = data.length > 0 ? data[0] : null;
      }

      return { data, error: null, count };
    } catch (err) {
      logger.error(`[DB Adapter Error] SQL: ${sql} | Msg: ${err.message}`);
      return { data: null, error: err, count: null };
    }
  }
}

const supabase = {
  from: (table) => new QueryBuilder(table),

  async rpc(fnName, params = {}) {
    if (isPostgres) {
      if (fnName === 'match_knowledge' && !hasPgVector) {
        try {
          const queryEmbedding = params.query_embedding;
          const matchThreshold = params.match_threshold || 0.3;
          const matchCount = params.match_count || 8;

          const res = await pool.query('SELECT id, title, content, source_url, embedding FROM knowledge_base WHERE is_active = true AND embedding IS NOT NULL;');
          const rows = res.rows.map(parseRow);

          const results = [];
          for (const row of rows) {
            let emb = row.embedding;
            if (Array.isArray(emb) && emb.length === queryEmbedding.length) {
              let dotProduct = 0;
              for (let i = 0; i < queryEmbedding.length; i++) {
                dotProduct += queryEmbedding[i] * (emb[i] || 0);
              }
              const similarity = dotProduct;
              if (similarity > matchThreshold) {
                results.push({
                  id: row.id,
                  title: row.title,
                  content: row.content,
                  source_url: row.source_url,
                  similarity: similarity
                });
              }
            }
          }

          results.sort((a, b) => b.similarity - a.similarity);
          const sliced = results.slice(0, matchCount);
          return { data: sliced, error: null };
        } catch (err) {
          logger.error(`[DB Adapter Postgres RPC Fallback Error] match_knowledge: ${err.message}`);
          return { data: null, error: err };
        }
      }

      let sql = '';
      const values = [];

      if (fnName === 'match_knowledge') {
        sql = 'SELECT * FROM match_knowledge($1, $2, $3)';
        values.push(formatValueForDriver(params.query_embedding), formatValueForDriver(params.match_threshold), formatValueForDriver(params.match_count));
      } else if (fnName === 'update_user_reputation') {
        sql = 'SELECT update_user_reputation($1, $2, $3, $4)';
        values.push(formatValueForDriver(params.p_channel_id), formatValueForDriver(params.p_user_id), formatValueForDriver(params.p_username), formatValueForDriver(params.p_delta));
      } else {
        const keys = Object.keys(params);
        const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ');
        sql = `SELECT * FROM ${fnName}(${placeholders})`;
        keys.forEach(k => values.push(formatValueForDriver(params[k])));
      }

      try {
        const res = await pool.query(sql, values);
        return { data: res.rows, error: null };
      } catch (err) {
        logger.error(`[DB Adapter RPC Error] RPC: ${fnName} | Msg: ${err.message}`);
        return { data: null, error: err };
      }
    } else {
      // SQLite Modus für RPCs
      if (fnName === 'match_knowledge') {
        try {
          const queryEmbedding = params.query_embedding;
          let matchThreshold = params.match_threshold || 0.3;
          const matchCount = params.match_count || 8;

          // Hole alle aktiven Wissenseinträge aus der SQLite DB
          const rows = await new Promise((resolve, reject) => {
            db.all('SELECT id, title, content, source_url, embedding FROM knowledge_base WHERE is_active = 1 AND embedding IS NOT NULL;', (err, resRows) => {
              if (err) reject(err);
              else resolve(resRows || []);
            });
          });

          const results = [];
          for (const row of rows) {
            let emb = null;
            try {
              emb = typeof row.embedding === 'string' ? JSON.parse(row.embedding) : row.embedding;
            } catch (e) {}

            if (Array.isArray(emb) && emb.length === queryEmbedding.length) {
              // Berechne Cosinus-Ähnlichkeit (da Vektoren bereits normalisiert sind = Skalarprodukt)
              let dotProduct = 0;
              for (let i = 0; i < queryEmbedding.length; i++) {
                dotProduct += queryEmbedding[i] * (emb[i] || 0);
              }
              const similarity = dotProduct;
              if (similarity > matchThreshold) {
                results.push({
                  id: row.id,
                  title: row.title,
                  content: row.content,
                  source_url: row.source_url,
                  similarity: similarity
                });
              }
            }
          }

          // Sortiere absteigend nach Similarity und Limitiere
          results.sort((a, b) => b.similarity - a.similarity);
          const sliced = results.slice(0, matchCount);
          return { data: sliced, error: null };
        } catch (err) {
          logger.error(`[DB Adapter SQLite RPC Error] match_knowledge: ${err.message}`);
          return { data: null, error: err };
        }
      } else if (fnName === 'update_user_reputation') {
        // Mock für update_user_reputation (wird nicht direkt aufgerufen, da catch-all)
        return { data: [], error: null };
      } else {
        logger.warn(`[DB Adapter SQLite] RPC ${fnName} nicht unterstützt im SQLite Modus.`);
        return { data: [], error: null };
      }
    }
  }
};

module.exports = supabase;
