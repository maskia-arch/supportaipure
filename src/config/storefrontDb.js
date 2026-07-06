const { Pool } = require('pg');
const supabase = require('./supabase');
const { storefrontDb: storefrontDbConfig } = require('./env');
const logger = require('../utils/logger');

const storefrontDbUrl = storefrontDbConfig.url;
const isStorefrontPostgres = !!(storefrontDbUrl && storefrontDbUrl.startsWith('postgres'));

let storefrontPool = null;

if (isStorefrontPostgres) {
  logger.info('[Storefront DB Setup] Using separate PostgreSQL database for storefront.');
  storefrontPool = new Pool({
    connectionString: storefrontDbUrl,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  });

  storefrontPool.on('error', (err) => {
    logger.error(`[Storefront DB Pool Error] ${err.message}`);
  });
} else {
  logger.info('[Storefront DB Setup] No separate STOREFRONT-DB connection URL configured. Falling back to primary database client.');
}

class StorefrontQueryBuilder {
  constructor(table) {
    this.table = table;
    this.selectFields = '*';
    this.countOption = null;
    this.isHead = false;
    this.conditions = [];
    this.orderFields = [];
    this.isMaybeSingle = false;
  }

  select(fields = '*', options = {}) {
    this.selectFields = fields || '*';
    this.countOption = options.count || null;
    this.isHead = options.head || false;
    return this;
  }

  eq(col, val) {
    this.conditions.push({ col, op: '=', val });
    return this;
  }

  or(conditionsString) {
    this.conditions.push({ op: 'OR', raw: conditionsString });
    return this;
  }

  order(col, options = {}) {
    const direction = options.ascending === false ? 'DESC' : 'ASC';
    this.orderFields.push(`"${col}" ${direction}`);
    return this;
  }

  maybeSingle() {
    this.isMaybeSingle = true;
    return this;
  }

  then(onfulfilled, onrejected) {
    return this.execute().then(onfulfilled, onrejected);
  }

  async execute() {
    let sql = '';
    const params = [];
    const placeholder = () => `$${params.length}`;

    if (this.isHead) {
      sql = `SELECT COUNT(*) AS __full_count FROM "${this.table}"`;
    } else {
      sql = `SELECT ${this.selectFields} FROM "${this.table}"`;
    }

    const compiledConds = [];
    for (const cond of this.conditions) {
      if (cond.op === '=') {
        params.push(cond.val);
        compiledConds.push(`"${cond.col}" = ${placeholder()}`);
      } else if (cond.op === 'OR') {
        // e.g., 'iccid.eq.XXX,top_up_iccid.eq.XXX'
        const parts = cond.raw.split(',');
        const orParts = [];
        for (const part of parts) {
          const subParts = part.trim().split('.');
          if (subParts.length >= 3) {
            const col = subParts[0];
            const op = subParts[1];
            const val = subParts.slice(2).join('.');
            if (op === 'eq') {
              params.push(val);
              orParts.push(`"${col}" = ${placeholder()}`);
            }
          }
        }
        if (orParts.length > 0) {
          compiledConds.push(`(${orParts.join(' OR ')})`);
        }
      }
    }

    if (compiledConds.length > 0) {
      sql += ` WHERE ${compiledConds.join(' AND ')}`;
    }

    if (this.orderFields.length > 0 && !this.isHead) {
      sql += ` ORDER BY ${this.orderFields.join(', ')}`;
    }

    if (this.isMaybeSingle && !this.isHead) {
      sql += ` LIMIT 1`;
    }

    try {
      const res = await storefrontPool.query(sql, params);
      let data = res.rows;
      let count = null;

      if (this.isHead) {
        count = parseInt(data[0].__full_count, 10);
        data = null;
      }

      if (this.isMaybeSingle) {
        data = (data && data.length > 0) ? data[0] : null;
      }

      return { data, error: null, count };
    } catch (err) {
      logger.error(`[Storefront DB Query Error] SQL: ${sql} | Msg: ${err.message}`);
      return { data: null, error: err, count: null };
    }
  }
}

const storefrontDb = isStorefrontPostgres ? {
  from: (table) => new StorefrontQueryBuilder(table)
} : supabase;

module.exports = storefrontDb;
