/**
 * knowledgeEnricher.js v2.1.0
 *
 * AI-Vorarbeiter für die eSIM-Wissensdatenbank (ValueShop25.com).
 * GPT-4o-mini kategorisiert und strukturiert jeden Eintrag
 * bevor er als Embedding in die KB gespeichert wird.
 */

const axios    = require('axios');
const supabase = require('../config/supabase');
const logger   = require('../utils/logger');

// ── Kategorie-Cache ────────────────────────────────────────────────────────
let _catCache     = null;
let _catCacheTime = 0;
const CAT_TTL = 10 * 60 * 1000;

// ── Die 5 richtigen eSIM-Kategorien ───────────────────────────────────────
const ESIM_CATEGORIES = [
  { name: 'Travel eSIM',         icon: '✈️',  color: '#3b82f6' },
  { name: 'Unlimited Eco eSIM',  icon: '🌿',  color: '#10b981' },
  { name: 'Unlimited Pro eSIM',  icon: '⚡',  color: '#8b5cf6' },
  { name: 'FAQ & Anleitung',     icon: '❓',  color: '#64748b' },
  { name: 'Technischer Support', icon: '🛠️', color: '#94a3b8' },
];

// ── Tariftyp-Beschreibungen (für KI-Kontext) ──────────────────────────────
const TARIFF_DESCRIPTIONS = {
  travel: `Travel eSIM: Datenvolumen-begrenzt. Wenn das Volumen aufgebraucht ist, funktioniert das Internet nicht mehr. Jederzeit aufladbar durch Kauf einer neuen eSIM oder Add-on.`,
  eco:    `Unlimited Eco eSIM: Highspeed-Volumen inklusive. Nach Verbrauch des Highspeed-Volumens wird die Verbindung auf 512 kb/s gedrosselt (weiterhin nutzbar, aber langsamer).`,
  pro:    `Unlimited Pro eSIM: Highspeed-Volumen inklusive. Nach Verbrauch des Highspeed-Volumens wird die Verbindung auf 1 Mbit/s gedrosselt (schneller als Eco nach Drossel).`,
};

const knowledgeEnricher = {

  // ── Kategorien anlegen (idempotent) ───────────────────────────────────────
  async ensureEsimCategories() {
    // Alte, ungewollte Auto-Kategorien aus früheren Versionen entfernen
    const OBSOLETE = [
      'Produkte & Tarife', 'Europa eSIM', 'Türkei eSIM', 'Asien & Pazifik eSIM',
      'Amerika eSIM', 'Naher Osten & Afrika eSIM', 'Weltweit / Global eSIM',
      'Unlimited Tarife', 'Kurzzeit-eSIMs', 'Langzeit-eSIMs',
      'Produkte', 'Tarife', 'Preise', 'FAQ', 'Support'
    ];
    try {
      await supabase.from('knowledge_categories').delete().in('name', OBSOLETE);
    } catch (_) {}

    try {
      const { data: existing } = await supabase
        .from('knowledge_categories').select('id, name');
      const existingNames = new Set((existing || []).map(c => c.name));
      const toCreate = ESIM_CATEGORIES.filter(c => !existingNames.has(c.name));

      if (toCreate.length === 0) {
        logger.info('[Enricher] Alle 5 Kategorien vorhanden ✅');
        _catCache = null; _catCacheTime = 0;
        return;
      }

      for (const cat of toCreate) {
        try {
          const { error } = await supabase.from('knowledge_categories').insert([{
            name: cat.name, icon: cat.icon, color: cat.color,
          }]);
          if (error) {
            try {
              await supabase.from('knowledge_categories').insert([{ name: cat.name }]);
            } catch (_) {}
            logger.warn(`[Enricher] "${cat.name}" ohne icon gespeichert (icon-Spalte fehlt noch)`);
          } else {
            logger.info(`[Enricher] Kategorie angelegt: ${cat.icon} ${cat.name}`);
          }
        } catch (e) {
          logger.warn(`[Enricher] Kategorie "${cat.name}": ${e.message}`);
        }
      }

      _catCache = null; _catCacheTime = 0;
    } catch (e) {
      logger.warn(`[Enricher] ensureEsimCategories: ${e.message}`);
    }
  },

  // ── Kategorien laden (gecacht) ─────────────────────────────────────────────
  async _getCategories() {
    const now = Date.now();
    if (_catCache && (now - _catCacheTime) < CAT_TTL) return _catCache;
    try {
      const { data } = await supabase
        .from('knowledge_categories').select('id, name, icon').order('id');
      _catCache = data || [];
      _catCacheTime = now;
      return _catCache;
    } catch { return []; }
  },

  // ── Tariftyp aus Produktname ableiten ─────────────────────────────────────
  _detectTariffType(name) {
    const n = (name || '').toLowerCase();
    if (/unlimited.*pro|pro.*unlimited/.test(n)) return 'pro';
    if (/unlimited.*eco|eco.*unlimited/.test(n)) return 'eco';
    if (/unlimited/.test(n)) return 'eco'; // Fallback für allgemeines Unlimited
    if (/travel/.test(n)) return 'travel';
    return 'travel'; // Standard-Fallback
  },

  // ── Zielkategorie aus Tariftyp ableiten ───────────────────────────────────
  async _getCategoryIdForTariff(tariffType, cats) {
    const nameMap = { travel: 'Travel eSIM', eco: 'Unlimited Eco eSIM', pro: 'Unlimited Pro eSIM' };
    const targetName = nameMap[tariffType] || 'Travel eSIM';
    return cats.find(c => c.name === targetName)?.id || cats[0]?.id || null;
  },

  // ── Titel aus Variantentext ────────────────────────────────────────────────
  _extractTitle(content) {
    const m = content.match(/Produkt:\s*(.+?)(?:\n|$)/i);
    if (m) return m[1].trim().substring(0, 70);
    return content.split('\n').find(l => l.trim().length > 5)?.trim().substring(0, 70) || 'eSIM';
  },

  // ── JSON-Parsing mit Fehlertoleranz ───────────────────────────────────────
  _safeParseGptJson(raw) {
    let clean = raw.replace(/```(?:json)?/gi, '').trim();
    try { return JSON.parse(clean); } catch (_) {}
    const lastBrace = clean.lastIndexOf('}');
    if (lastBrace > 0) {
      try { return JSON.parse(clean.substring(0, lastBrace + 1).replace(/,\s*$/, '') + ']'); } catch (_) {}
    }
    if (!clean.startsWith('[')) {
      try { return [JSON.parse(clean)]; } catch (_) {}
    }
    return null;
  },

  // ── Einzelner Eintrag anreichern ───────────────────────────────────────────
  async enrich(rawContent, source = 'unknown', hintCategoryId = null) {
    const { openai } = require('../config/env');

    const cats        = await this._getCategories();
    const tariffType  = this._detectTariffType(rawContent);
    const fallbackCat = await this._getCategoryIdForTariff(tariffType, cats);
    const catId       = hintCategoryId || fallbackCat;
    const fallbackTitle = this._extractTitle(rawContent);

    // Bei manueller Eingabe mit expliziter Kategorie: Kategorie FEST beibehalten
    const lockCategory = !!hintCategoryId;

    if (!openai?.apiKey) {
      return [{ content: rawContent, category_id: catId, title: fallbackTitle, enriched: false }];
    }

    if (cats.length === 0) {
      logger.warn('[Enricher] Keine Kategorien in DB – direkt speichern');
      return [{ content: rawContent, category_id: catId, title: fallbackTitle, enriched: false }];
    }

    const catList   = cats.map(c => `${c.id} = ${c.name}`).join(' | ');
    const tariffDesc = TARIFF_DESCRIPTIONS[tariffType] || TARIFF_DESCRIPTIONS.travel;

    // Prompt: bei gesperrter Kategorie GPT nur Titel+Content optimieren lassen
    const categoryInstruction = lockCategory
      ? `Die Kategorie ist bereits festgelegt (ID ${catId}) — gib diese ID unverändert zurück.`
      : `"category_id": <ID aus der Liste oben — passend zum Tariftyp>`;

    const prompt = `Du bist ein Wissensbank-Assistent für den eSIM-Shop ValueShop25.com.

TARIFTYP-KONTEXT:
${tariffDesc}

VERFÜGBARE KATEGORIEN: ${catList}

INHALT:
${rawContent.substring(0, 1500)}

AUFGABE: Erstelle GENAU 1 JSON-Objekt (kein Array):
{
  ${categoryInstruction},
  "title": "<prägnanter, suchbarer Titel, max 65 Zeichen>",
  "content": "<optimierter, strukturierter Beratungstext auf Deutsch. Behalte alle Fakten, Preise und Links bei.>"
}

Nur JSON zurückgeben, kein Markdown, kein Array.`;

    try {
      const resp = await axios.post(
        'https://api.openai.com/v1/chat/completions',
        {
          model:       'gpt-4o-mini',
          max_tokens:  600,
          temperature: 0.1,
          messages: [
            { role: 'system', content: 'Erstelle einen präzisen Wissenseintrag als JSON-Objekt. Kein Markdown.' },
            { role: 'user',   content: prompt }
          ]
        },
        { headers: { 'Authorization': `Bearer ${openai.apiKey}`, 'Content-Type': 'application/json' }, timeout: 25000 }
      );

      const raw  = resp.data.choices[0].message.content.trim();
      let parsed = this._safeParseGptJson(raw);
      if (Array.isArray(parsed)) parsed = parsed[0];
      if (!parsed || typeof parsed !== 'object') throw new Error('Kein gültiges JSON');

      const result = {
        content:     String(parsed.content || rawContent).trim(),
        title:       String(parsed.title   || fallbackTitle).trim().substring(0, 80),
        // Bei gesperrter Kategorie: IMMER die User-Wahl nehmen
        category_id: lockCategory ? catId : (Number(parsed.category_id) || catId),
        enriched:    true,
      };

      logger.info(`[Enricher] ✅ "${result.title}" → Kat ${result.category_id}${lockCategory ? ' (fix)' : ''}`);
      return [result];

    } catch (e) {
      logger.warn(`[Enricher] GPT Fallback (${e.message}): ${fallbackTitle}`);
      return [{ content: rawContent, category_id: catId, title: fallbackTitle, enriched: false }];
    }
  },

  // ── In KB speichern mit Embedding ─────────────────────────────────────────
  async enrichAndStore(rawContent, source, hintCategoryId, extraMeta = {}) {
    const deepseekService = require('./deepseekService');
    const entries = await this.enrich(rawContent, source, hintCategoryId);
    const saved   = [];

    for (const entry of entries) {
      try {
        const embResult = await deepseekService.generateEmbedding(entry.content);
        const embedding = embResult?.embedding || embResult;
        if (!embedding) { logger.warn(`[Enricher] Kein Embedding: ${entry.title}`); continue; }

        const { data } = await supabase.from('knowledge_base').insert([{
          content:     entry.content,
          title:       entry.title,
          embedding,
          source_type: source,
          category_id: entry.category_id,
          metadata:    { ...extraMeta, enriched: entry.enriched },
        }]).select('id, title, category_id');

        if (data?.[0]) saved.push(data[0]);
      } catch (e) {
        logger.warn(`[Enricher] Store: ${e.message}`);
      }
    }

    return saved;
  }
};

module.exports = knowledgeEnricher;
