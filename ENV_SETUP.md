# Coolify Environment Variable Setup

Um die Anwendung in Coolify erfolgreich zu betreiben, müssen folgende Umgebungsvariablen in den Einstellungen deiner App unter **Environment Variables** eingetragen werden.

## Übersicht der Umgebungsvariablen

| Variable | Beschreibung | Wichtigkeit / Status | Beispiel-Wert |
|---|---|---|---|
| **DATABASE_URL** | PostgreSQL-Verbindungs-URL für die eigene AI-Datenbank. Falls nicht definiert, nutzt die App SQLite automatisch (empfohlen via persistentem Volume). | **OPTIONAL** (Fallback auf SQLite) | `postgresql://postgres:pass@localhost:5432/esim_support_ai` |
| **STOREFRONT-DB** | PostgreSQL Connection String mit lesendem Zugriff auf die Storefront-Datenbank (für Tarif- und Bestell-Sync). | **WICHTIG / ERFORDERLICH** (für Sync) | `postgresql://postgres:pass@storefront-db-host:5432/storefront_db` |
| **DEEPSEEK_API_KEY** | API-Schlüssel für DeepSeek-Modelle (Haupt-Chat-AI) | **WICHTIG / ERFORDERLICH** | `sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx` |
| **TELEGRAM_BOT_TOKEN**| Token deines Telegram Support-Bots | **WICHTIG / ERFORDERLICH** | `1234567890:ABCdefGhIJKlmNoPQRsTUVwxyZ` |
| **ADMIN_USERNAME** | Benutzername für das Admin-Dashboard (/admin) | **WICHTIG / ERFORDERLICH** | `admin` |
| **ADMIN_PASSWORD** | Passwort für das Admin-Dashboard (/admin) | **WICHTIG / ERFORDERLICH** | `sicheres_passwort` |
| **JWT_SECRET** | Mindestens 32-stelliger String zur Signierung der Dashboard-Tokens | **WICHTIG / ERFORDERLICH** | `zufaelliger_min_32_zeichen_string` |
| **APP_URL** | Die öffentliche Adresse deiner Support-Anwendung | **WICHTIG / ERFORDERLICH** | `https://puresimaisupport.autoacts.link` |
| **STOREFRONT_URL** | Die öffentliche Adresse der Storefront (für Tariflinks im Chat) | **WICHTIG / ERFORDERLICH** | `https://autoacts.link` |
| **VAPID_PUBLIC_KEY** | Public Key für Web-Push-Benachrichtigungen im Dashboard | **WICHTIG / ERFORDERLICH** | `BF... (generiert über npm run generate-vapid)` |
| **VAPID_PRIVATE_KEY**| Private Key für Web-Push-Benachrichtigungen im Dashboard | **WICHTIG / ERFORDERLICH** | `xy... (generiert über npm run generate-vapid)` |
| **PORT** | Port auf dem der Node-Server horcht (Standard: 3000) | **OPTIONAL** | `3000` |
| **OPENAI_API_KEY** | API-Schlüssel für OpenAI (RAG Embeddings) | **OPTIONAL** (Fallback auf JS-Matching) | `sk-proj-xxxxxxxxxxxxxxxxxxxxxxxx` |
| **XAI_API_KEY** | API-Schlüssel für Grok | **OPTIONAL** | `xai-xxxxxxxxxxxxxxxxxxxxxxxx` |

---

## Einrichtung in Coolify Schritt-für-Schritt

1. Öffne dein Projekt in Coolify und wähle deine **Application** (NodeJS App).
2. Gehe in den Reiter **Environment Variables** (im linken Menü).
3. Klicke auf **Add Variable** (Variable hinzufügen) und trage die Keys und Values einzeln ein.
   - Die Variable `STOREFRONT-DB` muss auf die Verbindungsdaten der Storefront-Datenbank verweisen.
   - Falls du eine eigene PostgreSQL-Datenbank für die AI nutzt, trage sie in `DATABASE_URL` ein. Falls du SQLite nutzt, lass `DATABASE_URL` leer und richte stattdessen unter **Storages** ein Volume für `/usr/src/app/data` ein.
4. Klicke nach dem Speichern aller Variablen auf **Redeploy** (Neu deployen), damit die Variablen für den NodeJS-Container wirksam werden.
