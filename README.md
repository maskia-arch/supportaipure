# AI eSIM Berater (Standalone - VPS/Coolify)

Customer-Support-Bot mit Web-Widget und eigenem Admin-Dashboard, lauffähig auf dem eigenen VPS via Coolify.

## Was kann das?

- **Web-Widget**: Einbettbares Chat-Widget fuer deine Website
- **Telegram-Support-Bot**: Kunden koennen auch via Telegram chatten
- **Knowledge-Base mit RAG**: Wissensbasis durchsucht per Embedding-Vektor (PostgreSQL pgvector oder lokaler Javascript Cosine-Similarity Fallback)
- **Lernen-Workflow**: Unbeantwortete Fragen landen in einer Queue
- **Sellauth-Integration**: Bestellungen + Produkt-Lookup
- **Daily Coupons**: Aktionscodes nach Wochenplan
- **Visitor-Tracking**: Besucher-Sessions, Page-Views, Bans

## Architektur (SQLite - Empfohlen 🌟)

```
Coolify VPS-Service (NodeJS) ──── Lokale SQLite-Datenbank (/usr/src/app/data/sqlite.db)
       │
       ├── Telegram-Support-Bot (TELEGRAM_BOT_TOKEN)
       └── /widget.js → Kunden-Website
```

## Erstmal-Setup (SQLite - Ohne DB-Server-Konfiguration)

### 1. Volume in Coolify anlegen
1. Öffne deine Anwendung in Coolify.
2. Gehe auf **Storages** (Speicher) und füge ein Volume hinzu:
   - **Destination Path:** `/usr/src/app/data`
   - **Name:** z. B. `esim-bot-data`
3. Dadurch wird die SQLite-Datenbankdatei dauerhaft auf deinem VPS gespeichert und geht bei Updates nicht verloren.

### 2. Umgebungsvariablen setzen
Setze in Coolify unter **Environment Variables** folgende Werte:

```
DEEPSEEK_API_KEY=<DeepSeek-API-Key>
OPENAI_API_KEY=<OpenAI-Key fuer Embeddings>
TELEGRAM_BOT_TOKEN=<Support-Bot-Token>
ADMIN_USERNAME=<Dashboard-Login>
ADMIN_PASSWORD=<Dashboard-Passwort>
JWT_SECRET=<32-Zeichen-Zufallswert>
VAPID_PUBLIC_KEY=<Web-Push Public-Key>
VAPID_PRIVATE_KEY=<Web-Push Private-Key>
APP_URL=https://dein-berater.domain.de
PORT=3000
```
*(Hinweis: Lass `DATABASE_URL` einfach leer, damit die App automatisch SQLite nutzt.)*

### 3. Erstkonfiguration
1. Dashboard oeffnen: `https://dein-berater.domain.de/admin`
2. Einloggen (Tabellen werden beim ersten Start automatisch erstellt!)
3. Settings → System-Prompt anpassen
4. Settings → Sellauth → API-Key + Shop-ID eintragen → Sellauth-Sync starten
5. Knowledge-Base aufbauen: Manuelle Eintraege oder Scraper

### 4. Widget auf Website einbauen
Im `<head>` oder vor `</body>` der Kunden-Website:
```html
<script async src="https://dein-berater.domain.de/widget.js"></script>
```

---

## Alternative: PostgreSQL-Verwendung

Falls du lieber eine separate PostgreSQL-Datenbank nutzen möchtest:
1. Erstelle eine PostgreSQL-Datenbank in Coolify (mit `pgvector` Support).
2. Führe das Script `supabase/schema_full_v2.sql` auf deiner Datenbank aus.
3. Trage die `DATABASE_URL` in den Umgebungsvariablen deiner App ein.
   Format: `postgresql://[USER]:[PASSWORD]@[HOST]:[PORT]/[DB_NAME]`
   Die App wechselt dann automatisch in den PostgreSQL-Modus.
