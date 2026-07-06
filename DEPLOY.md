# eSIM Support Bot — Deploy-Anleitung (VPS / Coolify)

## 1. Voraussetzungen & Speicher-Modi (Isolierte Support-Datenbank)

Die Support-KI ist so konzipiert, dass sie **vollkommen unabhängig** in ihrer eigenen Datenbank operiert (Chats, Nachrichten, Dashboard-Einstellungen), jedoch exklusiven Lesezugriff auf die Tarife und Bestellungen der Storefront-Datenbank über die Variable `STOREFRONT-DB` erhält.

### Speicherort für AI-interne Daten (Chats, Messages, Settings)

Du kannst wählen zwischen:

#### Methode A: Lokale SQLite-Datenbank (Empfohlen 🌟)
- **Vorteil:** Benötigt **keine** zusätzliche Datenbank-Instanz und **keine** aufwendige Konfiguration. Die Vektorsuche (RAG) wird direkt in JavaScript berechnet.
- **Einrichtung:** Du musst in Coolify lediglich ein **Volume (Speicher-Volume)** hinzufügen, damit deine Daten Neustarts überleben.
- **Konfiguration:** Lass die Variable `DATABASE_URL` einfach leer bzw. trage sie gar nicht ein. Die App schwenkt automatisch auf SQLite um.

#### Methode B: Eigene PostgreSQL-Datenbank
- **Einrichtung:** Erstelle einen PostgreSQL-Service in Coolify für diese App (z.B. pgvector-Image `ankane/pgvector`) und lasse das Schema automatisch beim ersten Start erzeugen.
- **Konfiguration:** Setze die Umgebungsvariable `DATABASE_URL` auf deinen PostgreSQL-Connection-String.

### Zugriff auf Storefront-Daten (Tarife, Bestellungen)

- **Konfiguration:** Du musst die Umgebungsvariable `STOREFRONT-DB` setzen. Sie enthält den PostgreSQL-Connection-String der Storefront-Datenbank. Die Support-KI liest daraus ausschließlich Tarife für den Produkt-Sync sowie Bestellungen für die Rechnungsprüfung.

---

## 2. Einrichtung unter Coolify (Schritt-für-Schritt)

1. **Ressource hinzufügen:** Erstelle eine neue Application in Coolify: **Application -> GitHub Repository**.
2. **Repository & Branch:** Wähle dein Repository (`maskia-arch/AI-Support`) und den Branch `main`.
3. **Build-System:** Coolify nutzt automatisch das im Hauptverzeichnis liegende `Dockerfile` (Node 20).
4. **Volume hinzufügen (WICHTIG für Daten-Persistenz bei SQLite):**
   - Falls du **SQLite** nutzt, gehe in deiner Coolify-Anwendung auf den Reiter **Storages** (Speicher).
   - Füge ein neues Volume hinzu:
     - **Destination Path (Zielpfad):** `/usr/src/app/data`
     - **Name:** z. B. `esim-bot-data`
   - Dadurch wird die SQLite-Datenbank (`sqlite.db`) außerhalb des Containers auf deinem VPS gespeichert und überlebt Updates und Restarts der App.

5. **Umgebungsvariablen eintragen:**
   Gehe in deiner Coolify-Anwendung auf **Environment Variables** und trage folgende Werte ein (gemäss der [.env.example](file:///c:/Users/Laptop/Desktop/esim%20website/esim-supportai/.env.example)):
   - `STOREFRONT-DB`: Verbindungsdaten der Storefront-Datenbank.
   - `DEEPSEEK_API_KEY`: Dein DeepSeek API-Schlüssel.
   - `TELEGRAM_BOT_TOKEN`: Dein Telegram-Bot-Token.
   - `ADMIN_USERNAME` & `ADMIN_PASSWORD`: Gewünschte Zugangsdaten für das Dashboard.
   - `JWT_SECRET`: Ein sicherer, zufälliger String (min 32 Zeichen).
   - `APP_URL`: `https://puresimaisupport.autoacts.link`
   - `STOREFRONT_URL`: `https://autoacts.link`
   - `VAPID_PUBLIC_KEY` & `VAPID_PRIVATE_KEY`: Deine Web-Push-Schlüssel (erzeugt via `npm run generate-vapid`).
   - `PORT`: `3000`.
   - *(Optional `DATABASE_URL` für eigene PostgreSQL-Datenbank, falls kein SQLite genutzt werden soll)*

6. **Deployen:** Klicke oben rechts auf **Deploy**. Die App baut den NodeJS-Container, initialisiert die Datenbank automatisch beim ersten Start und läuft los!

---

## 3. Erstkonfiguration & Widget-Einbettung

1. Nach erfolgreichem Deployment öffne das Dashboard unter `https://puresimaisupport.autoacts.link/admin`.
2. Logge dich mit deinen Admin-Zugangsdaten ein.
3. Passe unter **Settings** den System-Prompt an, trage eventuelle Shop-Einstellungen ein und starte den Synchronisationsvorgang (dadurch werden Tarife aus der Storefront-DB geladen, aufbereitet und als Wissen in die AI-Datenbank geschrieben).
4. Binde das Web-Widget auf deiner Kunden-Website ein, indem du das Script hinzufügst:
   ```html
   <script async src="https://puresimaisupport.autoacts.link/widget.js"></script>
   ```
