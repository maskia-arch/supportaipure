/**
 * deepseekService.js v1.3.5
 * Cache-optimierter Prompt-Aufbau für maximale DeepSeek Cache-Hits.
 * Statischer Teil (Regeln) zuerst → Cache-Hit-Rate ~60-80%.
 */

const axios   = require('axios');
const supabase = require('../config/supabase');
const { deepseek, openai, grok } = require('../config/env');

// ── Modell-Auswahl (Dashboard → Einstellungen → Bot) ────────────────────────
// Dropdown-Wert → Anbieter. Der echte API-Modellstring kommt aus env (überschreibbar).
const MODEL_REGISTRY = {
  'deepseek-v4-flash':       { provider: 'deepseek', label: 'DeepSeek V4 Flash (thinking disabled)' },
  'gpt-5.4-nano':            { provider: 'openai',   label: 'GPT 5.4 Nano' },
  'grok-4.3-non-reasoning':  { provider: 'grok',     label: 'Grok 4.3 (Non-Reasoning)' },
};
const DEFAULT_MODEL = 'deepseek-v4-flash';

const PROVIDERS = {
  deepseek: { baseUrl: deepseek.baseUrl, apiKey: deepseek.apiKey, model: deepseek.chatModel, tokenParam: 'max_tokens' },
  openai:   { baseUrl: openai.baseUrl,   apiKey: openai.apiKey,   model: openai.chatModel,   tokenParam: 'max_completion_tokens' },
  grok:     { baseUrl: grok.baseUrl,     apiKey: grok.apiKey,     model: grok.chatModel,     tokenParam: 'max_tokens' },
};

function _resolveProvider(modelKey) {
  const reg  = MODEL_REGISTRY[modelKey] || MODEL_REGISTRY[DEFAULT_MODEL];
  const prov = PROVIDERS[reg.provider]  || PROVIDERS.deepseek;
  return { ...prov, providerName: reg.provider, label: reg.label };
}
const logger  = require('../utils/logger');

// Statische Formatierungsregeln – werden von DeepSeek gecacht (0.01$/M statt 0.28$/M)
const FORMAT_RULES = `

AUSGABE-FORMAT (STRIKT):
Antworte ausschließlich in reinem Plain-Text — KEIN Markdown.
VERBOTEN: **fett**, *kursiv*, ***bold-italic***, __underline__, ###Header, \`code\`, [Link](url), - bullet
ERLAUBT: Listen mit "1." oder "•", Leerzeilen, direkte URLs als Plain-Text

UNSICHERHEITS-REGELN:
1. Antwort NICHT aus Kontext beantwortbar → Antwort beginnt mit [UNKLAR]
2. NIEMALS raten, schätzen oder Daten erfinden
3. NIEMALS "Ausverkauft" sagen ohne expliziten Hinweis in der Wissensdatenbank

BESTELLSTATUS: Wenn Kunde nach Bestellung fragt →
"Sende: /order DEINE_INVOICE_ID (aus Bestätigungs-E-Mail)"

TAGES-COUPON: Wenn Kunde nach Rabatt, Coupon, Angebot oder Aktion fragt →
Der aktuelle Coupon-Code wird dir als Teil des Kontexts mitgeteilt (AKTUELLER COUPON).
Wenn ein Coupon aktiv ist: Nenne den Code und die Beschreibung. Weise auf ValueShop25.com hin.
Wenn kein Coupon-Kontext vorhanden: "Gerade haben wir keinen aktiven Code. Schau morgen wieder vorbei!"`

// PRODUKT-REGELN — werden bei JEDER Antwort angewendet, mit oder ohne Kontext
const PRODUCT_RULES = `

▶▶▶ PRODUKT-REGELN (HÖCHSTE PRIORITÄT) ◀◀◀
DIESE REGELN GELTEN ÜBER ALLEM ANDEREN. NIE BRECHEN.

VERBOTEN — wird zu Halluzination führen:
• Tarife, Preise, GB-Mengen, Laufzeiten ERFINDEN oder SCHÄTZEN
• Auch wenn der Kunde mehrmals fragt: KEINE erfundenen Listen
• URLs erfinden — nur Links die WÖRTLICH in der Wissensdatenbank stehen
• Aus dem Gedächtnis/Training Tarif-Listen rekonstruieren

PFLICHT — wenn KEIN passender Tarif in der Wissensdatenbank:
Antworte WÖRTLICH (kein Ausweichen):
"Für diesen speziellen Tarif/dieses Land haben wir aktuell kein passendes Angebot in unserer Wissensdatenbank. Für individuelle Beratung wende dich bitte an @autoacts."

WICHTIG: Wenn du oben gesagt hast "kein Tarif vorhanden" und der Kunde danach
mit Worten wie "tarife", "Liste", "alle", "trotzdem" nachfragt, BLEIBE bei dieser
Aussage. Wiederhole nur: "Wir haben dazu nichts. @autoacts kann dir individuell helfen."

ERLAUBT:
• Nur Produkte/Tarife empfehlen die EXPLIZIT mit Namen UND Preis UND Link in der Wissensdatenbank stehen
• Kauflink + Preis IMMER 1:1 aus Wissensdatenbank-Eintrag übernehmen — kein Kürzen, kein Umformulieren`;

// SPRACH-REGELN — werden als LETZTE und damit stärkste Anweisung angehängt.
// Erzwingt, dass die KI in der Sprache des Kunden antwortet, egal welche.
const LANGUAGE_RULES = `

${'═'.repeat(38)}
SPRACHE / LANGUAGE (HÖCHSTE PRIORITÄT — überschreibt alle anderen Sprachangaben oben):
${'═'.repeat(38)}
Erkenne die Sprache des Kunden aus SEINER LETZTEN NACHRICHT und antworte VOLLSTÄNDIG in genau dieser Sprache.
- Schreibt der Kunde auf Englisch → antworte komplett auf Englisch.
- Schreibt der Kunde auf Deutsch → antworte auf Deutsch.
- Türkisch, Französisch, Spanisch, Italienisch, Arabisch usw. → antworte in genau dieser Sprache.
- Wechselt der Kunde die Sprache, wechselst du mit.

Detect the customer's language from THEIR LAST MESSAGE and reply ENTIRELY in that same language. This rule overrides any "antworte auf Deutsch" instruction above.

ÜBERSETZE auch ALLE Standard-Sätze in die Sprache des Kunden (sinngemäß, nicht wörtlich Deutsch):
- Bestellstatus-Hinweis, Coupon-Hinweise, Unsicherheits-/Fallback-Antworten, Hinweise auf @autoacts.
NICHT übersetzen / unverändert lassen: Produktnamen, Coupon-Codes, Preise, Zahlen, URLs/Kauflinks, der Marker [UNKLAR].`;


const deepseekService = {

  async generateResponse(userMessage, history = [], contextDocs = [], chatId = null, settings = {}, chatSummary = null) {
    const modelKey    = settings.ai_model         || DEFAULT_MODEL;
    const maxTokens   = parseInt(settings.ai_max_tokens)    || 1024;
    // Sehr niedrige Temperatur reduziert Halluzinationen drastisch
    const temperature = parseFloat(settings.ai_temperature) || 0.2;

    const prov = _resolveProvider(modelKey);
    if (!prov.apiKey) {
      logger.error(`[AI] Kein API-Key für Anbieter "${prov.providerName}" (${prov.label}). ENV prüfen.`);
      return { text: null, promptTokens: 0, completionTokens: 0, cachedTokens: 0, error: `no_api_key_${prov.providerName}` };
    }

    let messages;
    try {
      const systemContent = this._buildSystemPrompt(settings, contextDocs, chatSummary);
      messages = [
        { role: 'system', content: systemContent },
        ...(history || []),
        { role: 'user', content: userMessage }
      ];
    } catch (e) {
      logger.error(`[AI] Prompt-Bau-Fehler: ${e.message}`);
      return { text: null, promptTokens: 0, completionTokens: 0, cachedTokens: 0, error: 'prompt_build_failed' };
    }

    // Mehrere Versuche gegen vorübergehende Fehler (Timeout, 5xx, Rate-Limit, leere Antwort).
    // Verhindert, dass der Nutzer bei einem kurzen Aussetzer keine Antwort bekommt.
    const maxAttempts = 3;
    let lastError = 'unknown';

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const response = await this._chatCompletion(prov, messages, temperature, maxTokens);
        const choice   = response?.data?.choices?.[0]?.message?.content ?? null;

        if (choice && choice.trim()) {
          const usage = response.data.usage || {};

          if (choice.includes('[UNKLAR]') && chatId) {
            // WICHTIG: kein .catch() auf Supabase-QueryBuilder (wirft "catch is not a function").
            void (async () => {
              try {
                await supabase.from('learning_queue').insert([{
                  original_chat_id: chatId, unanswered_question: userMessage, status: 'pending'
                }]);
              } catch (_) {}
            })();
          }

          return {
            text:             choice,
            promptTokens:     usage.prompt_tokens          || 0,
            completionTokens: usage.completion_tokens       || 0,
            cachedTokens:     usage.prompt_cache_hit_tokens || 0
          };
        }

        // Leere Antwort → erneut versuchen
        lastError = 'empty_response';
        logger.warn(`[AI] Leere Antwort (Versuch ${attempt}/${maxAttempts}) — ${prov.providerName}/${prov.model}`);
      } catch (err) {
        const status = err.response?.status;
        lastError = err.response?.data?.error?.message || err.message || 'Timeout/Aborted';
        logger.warn(`[AI] Fehler (Versuch ${attempt}/${maxAttempts}) ${prov.providerName}/${prov.model}: ${lastError}`);
        // Auth-/Berechtigungsfehler bringen keinen Retry
        if (status === 401 || status === 403) break;
      }

      // Kurzer Backoff vor dem nächsten Versuch (0.7s, 1.4s)
      if (attempt < maxAttempts) {
        await new Promise(r => setTimeout(r, 700 * attempt));
      }
    }

    logger.error(`[AI] Endgültig fehlgeschlagen nach ${maxAttempts} Versuchen: ${lastError}`);
    return { text: null, promptTokens: 0, completionTokens: 0, cachedTokens: 0, error: lastError };
  },

  // Provider-agnostischer Chat-Completion-Call mit Parameter-Retry.
  // Fängt Eigenheiten neuer Modelle ab (z.B. OpenAI: max_completion_tokens
  // statt max_tokens, oder Temperatur nur =1 erlaubt).
  async _chatCompletion(prov, messages, temperature, maxTokens) {
    const url     = `${prov.baseUrl}/v1/chat/completions`;
    const headers = { 'Authorization': `Bearer ${prov.apiKey}`, 'Content-Type': 'application/json' };

    const body1 = { model: prov.model, messages, temperature };
    body1[prov.tokenParam] = maxTokens;

    try {
      return await axios.post(url, body1, { headers, timeout: 45000 });
    } catch (err) {
      const status = err.response?.status;
      const emsg   = (err.response?.data?.error?.message || '').toLowerCase();
      const paramIssue = status === 400 && (
        emsg.includes('temperature') || emsg.includes('max_tokens') ||
        emsg.includes('max_completion_tokens') || emsg.includes('unsupported') ||
        emsg.includes('not supported') || emsg.includes('unknown parameter')
      );
      if (!paramIssue) throw err;

      // Retry: anderen Token-Parameter nutzen + Temperatur weglassen (Default verwenden)
      const altTokenParam = prov.tokenParam === 'max_tokens' ? 'max_completion_tokens' : 'max_tokens';
      const body2 = { model: prov.model, messages };
      body2[altTokenParam] = maxTokens;
      logger.warn(`[AI] Parameter-Retry für ${prov.providerName}/${prov.model} (${emsg.substring(0, 70)})`);
      return await axios.post(url, body2, { headers, timeout: 45000 });
    }
  },

  // Cache-Strategie: statisch → semi-statisch → dynamisch
  _buildSystemPrompt(settings, contextDocs, chatSummary) {
    const base = settings.system_prompt  || `Du bist ein freundlicher eSIM-Berater für ValueShop25.com.

DEINE HAUPTAUFGABE: Ermittle den Bedarf des Kunden und empfehle die passende eSIM.

TARIFTYPEN:
• Travel eSIM: Begrenztes Datenvolumen. Kein Internet mehr wenn verbraucht. Jederzeit aufladbar.
• Unlimited Eco: Highspeed-Volumen inklusive, danach Drosselung auf 512 kb/s (weiterhin nutzbar).
• Unlimited Pro: Highspeed-Volumen inklusive, danach Drosselung auf 1 Mbit/s (schneller als Eco nach Drossel).

BERATUNGS-ABLAUF:
1. Reiseziel des Kunden herausfinden (welches Land?)
2. Nutzung klären (nur WhatsApp/Social = wenig Daten, Navigation/Streaming = viel)
3. Reisedauer erfragen
4. Passende eSIM mit Preis und Kauflink empfehlen

REGELN:
- Antworte kurz und direkt in der Sprache des Kunden
- Nenne immer Preis und Kauflink bei Empfehlung
- Erfinde NIEMALS Preise oder Produktdetails
- Wenn unsicher: beginne Antwort mit [UNKLAR]`;
    const neg  = settings.negative_prompt || '';

    // 1. Basis-Prompt + Format-Regeln + Produkt-Regeln (alles statisch, immer im Cache)
    // PRODUCT_RULES gelten IMMER — auch ohne Kontext-Treffer. Das verhindert, dass
    // das Modell aus seinem Training erfundene Tarif-Listen rekonstruiert.
    let p = base + FORMAT_RULES + PRODUCT_RULES;

    if (neg) p += `\n\nVERBOTENE VERHALTENSWEISEN:\n${neg}`;

    // 2. RAG-Kontext (semi-statisch – ändert sich nur bei DB-Updates)
    if (contextDocs && contextDocs.length > 0) {
      const ctx = contextDocs.map((d, i) => `[${i+1}] ${d.content}`).join('\n\n---\n\n');
      p += `\n\n${'═'.repeat(38)}\nWISSENSDATENBANK (einzige Quelle der Wahrheit):\n${'═'.repeat(38)}\n${ctx}\n${'═'.repeat(38)}\nNur diese Produkte empfehlen. Kauflink + Preis IMMER 1:1 aus DB übernehmen.`;
    } else {
      // KEIN Kontext gefunden → noch deutlicher: "DU HAST NICHTS"
      p += `\n\n${'═'.repeat(38)}\nWISSENSDATENBANK: LEER für diese Anfrage\n${'═'.repeat(38)}\nDu hast KEINE Produkt-Daten für diese Frage. Bei jeder Produkt-/Tarif-/Preis-Frage antwortest du sinngemäß IN DER SPRACHE DES KUNDEN:\n"Für diesen speziellen Tarif/dieses Land haben wir aktuell kein passendes Angebot in unserer Wissensdatenbank. Für individuelle Beratung wende dich bitte an @autoacts."\nKEINE erfundenen Tarife, KEINE Listen aus dem Gedächtnis, KEINE Beispiele.`;
    }

    // 3. Chat-Zusammenfassung (pro Chat, aber stabil zwischen Updates)
    if (chatSummary) {
      p += `\n\nKONTEXT (frühere Nachrichten):\n${chatSummary}`;
    }

    // 4. SPRACH-REGEL als allerletzte (stärkste) Anweisung anhängen
    p += LANGUAGE_RULES;

    return p;
  },

  // Asynchrone Chat-Zusammenfassung (spart Input-Tokens)
  async summarizeChat(messages, existingSummary = null) {
    if (!messages || messages.length < 2) return null;
    const text = messages
      .filter(m => m.role !== 'system')
      .map(m => `${m.role === 'user' ? 'Kunde' : 'KI'}: ${(m.content||'').substring(0, 300)}`)
      .join('\n');

    const prompt = existingSummary
      ? `Bisherige Zusammenfassung:\n${existingSummary}\n\nNeue Nachrichten:\n${text}\n\nAktualisiere kompakt (max 120 Wörter). Behalte wichtige Fakten: Produktinteresse, Fragen, Bestellnummern.`
      : `Fasse kompakt zusammen (max 120 Wörter). Wichtig: Produktinteresse, offene Fragen, Bestellnummern.\n\n${text}`;

    try {
      const r = await axios.post(
        `${deepseek.baseUrl}/v1/chat/completions`,
        {
          model: deepseek.chatModel, max_tokens: 180, temperature: 0.1,
          messages: [
            { role: 'system', content: 'Kompakte deutsche Chat-Zusammenfassung. Nur Fakten, kein Fließtext.' },
            { role: 'user',   content: prompt }
          ]
        },
        { headers: { 'Authorization': `Bearer ${deepseek.apiKey}` }, timeout: 20000 }
      );
      return r.data.choices[0].message.content.trim();
    } catch (e) {
      logger.warn(`[DS] Summary Error: ${e.message}`);
      return existingSummary;
    }
  },

  async generateEmbedding(text) {
    try {
      const r = await axios.post(
        'https://api.openai.com/v1/embeddings',
        { model: 'text-embedding-3-small', input: text.replace(/\n/g, ' ').substring(0, 8000) },
        { headers: { 'Authorization': `Bearer ${openai.apiKey}` }, timeout: 15000 }
      );
      return {
        embedding: r.data.data[0].embedding,
        tokens:    r.data.usage?.total_tokens || 0
      };
    } catch (err) {
      const msg = err.response?.data?.error?.message || err.message;
      logger.error(`[DS] Embedding Error: ${msg}`);
      throw new Error(`Embedding fehlgeschlagen: ${msg}`);
    }
  },

  async processLearningResponse(adminAnswer, questionId) {
    const { data: q } = await supabase.from('learning_queue').select('*').eq('id', questionId).single();
    if (!q) throw new Error('Frage nicht gefunden');
    const content    = `Frage: ${q.unanswered_question}\nAntwort: ${adminAnswer}`;
    const { embedding } = await this.generateEmbedding(content);
    await supabase.from('knowledge_base').insert([{ content, embedding, source_type: 'learning_chat' }]);
    await supabase.from('learning_queue').update({ status: 'resolved' }).eq('id', questionId);
    return true;
  }
};

module.exports = deepseekService;
