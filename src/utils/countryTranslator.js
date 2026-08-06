/**
 * countryTranslator.js
 *
 * Übersetzt Ländernamen aus allen Sprachen (Italienisch, Englisch, Französisch, Spanisch, ISO-Codes, Slugs)
 * zuverlässig in korrekte deutsche Ländernamen für das Support-Dashboard und Push-Benachrichtigungen.
 */

const GERMAN_COUNTRY_MAP = {
  // Ägypten
  'egitto': 'Ägypten', 'egypt': 'Ägypten', 'égypte': 'Ägypten', 'egipto': 'Ägypten', 'egipt': 'Ägypten', 'mısır': 'Ägypten', 'eg': 'Ägypten',
  
  // Italien
  'italien': 'Italien', 'italy': 'Italien', 'italia': 'Italien', 'italie': 'Italien', 'italië': 'Italien', 'włochy': 'Italien', 'italya': 'Italien', 'it': 'Italien',

  // Schweiz
  'schweiz': 'Schweiz', 'switzerland': 'Schweiz', 'suisse': 'Schweiz', 'svizzera': 'Schweiz', 'suíça': 'Schweiz', 'szwajcaria': 'Schweiz', 'ch': 'Schweiz',

  // Türkei
  'türkei': 'Türkei', 'turkey': 'Türkei', 'turquie': 'Türkei', 'turquía': 'Türkei', 'türkiye': 'Türkei', 'turcja': 'Türkei', 'tr': 'Türkei',

  // Spanien
  'spanien': 'Spanien', 'spain': 'Spanien', 'españa': 'Spanien', 'espagne': 'Spanien', 'spagna': 'Spanien', 'hiszpania': 'Spanien', 'ispanya': 'Spanien', 'es': 'Spanien',

  // USA & Nordamerika
  'usa': 'USA', 'united states': 'USA', 'états-unis': 'USA', 'estados unidos': 'USA', 'stati uniti': 'USA', 'stany zjednoczone': 'USA', 'us': 'USA',
  'kanada': 'Kanada', 'canada': 'Kanada', 'ca': 'Kanada',

  // Vereinigte Arabische Emirate & Dubai
  'dubai': 'Dubai (VAE)', 'vae': 'Vereinigte Arabische Emirate', 'uae': 'Vereinigte Arabische Emirate', 'united arab emirates': 'Vereinigte Arabische Emirate', 'émirats arabes unis': 'Vereinigte Arabische Emirate', 'emiratos árabes unidos': 'Vereinigte Arabische Emirate', 'emiraty arabskie': 'Vereinigte Arabische Emirate', 'birleşik arap emirlikleri': 'Vereinigte Arabische Emirate', 'ae': 'Vereinigte Arabische Emirate',

  // Thailand
  'thailand': 'Thailand', 'thaïlande': 'Thailand', 'tailandia': 'Thailand', 'tailandia': 'Thailand', 'tajlandia': 'Thailand', 'tayland': 'Thailand', 'th': 'Thailand',

  // Japan
  'japan': 'Japan', 'japon': 'Japan', 'japón': 'Japan', 'giappone': 'Japan', 'japonia': 'Japan', 'japonya': 'Japan', 'jp': 'Japan',

  // Griechenland
  'griechenland': 'Griechenland', 'greece': 'Griechenland', 'grèce': 'Griechenland', 'grecia': 'Griechenland', 'grecja': 'Griechenland', 'yunanistan': 'Griechenland', 'gr': 'Griechenland',

  // Frankreich
  'frankreich': 'Frankreich', 'france': 'Frankreich', 'francia': 'Frankreich', 'francja': 'Frankreich', 'fransa': 'Frankreich', 'fr': 'Frankreich',

  // Großbritannien / UK
  'großbritannien': 'Großbritannien', 'united kingdom': 'Großbritannien', 'uk': 'Großbritannien', 'royaume-uni': 'Großbritannien', 'reino unido': 'Großbritannien', 'regno unito': 'Großbritannien', 'wielka brytania': 'Großbritannien', 'gb': 'Großbritannien',

  // Türkei & Zypern
  'zypern': 'Zypern', 'cyprus': 'Zypern', 'chypre': 'Zypern', 'chipre': 'Zypern', 'cipro': 'Zypern', 'cypr': 'Zypern', 'cy': 'Zypern',

  // Marokko
  'marokko': 'Marokko', 'morocco': 'Marokko', 'maroc': 'Marokko', 'marruecos': 'Marokko', 'marocco': 'Marokko', 'maroko': 'Marokko', 'ma': 'Marokko',

  // Tunesien
  'tunesien': 'Tunesien', 'tunisia': 'Tunesien', 'tunisie': 'Tunesien', 'túnez': 'Tunesien', 'tunazja': 'Tunesien', 'tn': 'Tunesien',

  // Mexiko
  'mexiko': 'Mexiko', 'mexico': 'Mexiko', 'mexique': 'Mexiko', 'méxico': 'Mexiko', 'messico': 'Mexiko', 'meksyk': 'Mexiko', 'mx': 'Mexiko',

  // Malediven & Bali / Indonesien
  'malediven': 'Malediven', 'maldives': 'Malediven', 'maldivas': 'Malediven', 'maldive': 'Malediven', 'mv': 'Malediven',
  'indonesien': 'Indonesien', 'indonesia': 'Indonesien', 'indonésie': 'Indonesien', 'indonezja': 'Indonesien', 'bali': 'Bali (Indonesien)', 'id': 'Indonesien',

  // Vietnam
  'vietnam': 'Vietnam', 'viêt nam': 'Vietnam', 'wietnam': 'Vietnam', 'vn': 'Vietnam',

  // Brasilien
  'brasilien': 'Brasilien', 'brazil': 'Brasilien', 'brésil': 'Brasilien', 'brasil': 'Brasilien', 'brasile': 'Brasilien', 'brazylia': 'Brasilien', 'br': 'Brasilien',

  // Kolumbien
  'kolumbien': 'Kolumbien', 'colombia': 'Kolumbien', 'colombie': 'Kolumbien', 'kolumbia': 'Kolumbien', 'co': 'Kolumbien',

  // Kroatien
  'kroatien': 'Kroatien', 'croatia': 'Kroatien', 'croatie': 'Kroatien', 'croacia': 'Kroatien', 'chorwacja': 'Kroatien', 'hr': 'Kroatien',

  // Portugal
  'portugal': 'Portugal', 'pt': 'Portugal',

  // Albanien
  'albanien': 'Albanien', 'albania': 'Albanien', 'albanie': 'Albanien', 'al': 'Albanien',

  // Montenegro
  'montenegro': 'Montenegro', 'czarnogóra': 'Montenegro', 'me': 'Montenegro'
};

const countryTranslator = {
  /**
   * Übersetzt einen Suchbegriff oder Ländernamen ins Deutsche.
   * Gibt bei Treffern z. B. "Ägypten" statt "Egitto" oder "Egypt" zurück.
   */
  translate(input) {
    if (!input || typeof input !== 'string') return '';
    const clean = input.trim().toLowerCase().replace(/[-_]/g, ' ');

    // 1. Echter Treffer im Wörterbuch
    if (GERMAN_COUNTRY_MAP[clean]) {
      return GERMAN_COUNTRY_MAP[clean];
    }

    // 2. Suche nach Schlüsselwörtern im String (z.B. "egitto 10gb" -> "Ägypten")
    for (const [key, val] of Object.entries(GERMAN_COUNTRY_MAP)) {
      if (key.length >= 3) {
        const regex = new RegExp(`\\b${key}\\b`, 'i');
        if (regex.test(clean)) {
          return val;
        }
      }
    }

    // 3. Fallback: Ersten Buchstaben großschreiben
    return input.charAt(0).toUpperCase() + input.slice(1);
  },

  /**
   * Formatiert Such-Titel für das Dashboard strictly auf Deutsch.
   * Beispiel: "egitto" -> "Tarif-Suche: Ägypten"
   */
  formatSearchTitle(query) {
    if (!query) return 'Tarifübersicht';
    const translated = this.translate(query);
    return `Tarif-Suche: ${translated}`;
  },

  /**
   * Formatiert Tarif-Detailseiten auf Deutsch.
   * Beispiel: "egitto-10-gb" -> "Tarif: Ägypten"
   */
  formatTariffDetailTitle(slug) {
    if (!slug) return 'Tarifdetails';
    const translated = this.translate(slug);
    return `Tarif: ${translated}`;
  }
};

module.exports = countryTranslator;
