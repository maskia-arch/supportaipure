/**
 * sw.js – Service Worker für Web Push Notifications v2.0
 *
 * Verbesserungen gegenüber v1:
 *  • requireInteraction: true  → Notification bleibt sichtbar bis der Admin tippt
 *  • Android Doze-Mode safe: vibrate + sound explizit
 *  • Besseres Klick-Handling: chatId direkt im URL-Anchor
 *  • Robusteres JSON-Parsing mit mehreren Fallbacks
 *  • Cache-Version hochgezählt → erzwingt SW-Update auf allen Geräten
 */

const CACHE_VERSION = 'ai-admin-v4';

// ── Install: sofort aktiv werden ─────────────────────────────────────────────
self.addEventListener('install', function(event) {
  self.skipWaiting();
});

// ── Activate: Kontrolle über alle Clients ────────────────────────────────────
self.addEventListener('activate', function(event) {
  event.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(
        keys.filter(function(k) { return k !== CACHE_VERSION; })
            .map(function(k) { return caches.delete(k); })
      );
    }).then(function() {
      return self.clients.claim();
    })
  );
});

// ── Push: Notification anzeigen ──────────────────────────────────────────────
self.addEventListener('push', function(event) {
  // Robustes Parsing: JSON → text → Fallback
  var data = { title: '💬 Neue Nachricht', body: 'PureSim Support' };

  if (event.data) {
    try {
      data = event.data.json();
    } catch (_) {
      try {
        var txt = event.data.text();
        if (txt) data.body = txt;
      } catch (__) {}
    }
  }

  // Sicherstellen dass title und body immer Strings sind
  var title = String(data.title || '💬 PureSim Support');
  var body  = String(data.body  || '');
  var url   = data.url    || '/admin';
  var tag   = data.tag    || ('ps-' + Date.now());

  var options = {
    body:    body,
    icon:    data.icon || '/icon-192.png',
    badge:   '/icon-72.png',
    tag:     tag,

    // ── Android-kritische Einstellungen ──────────────────────────────────
    // requireInteraction: true → Notification bleibt sichtbar bis der Admin
    // explizit tippt. Verhindert dass Android sie im Doze-Modus verwirft.
    requireInteraction: true,

    // renotify: true → Ton + Vibration auch wenn gleicher Tag
    renotify: true,

    // Vibrationsmuster: Android braucht explizite Angabe
    vibrate: [300, 150, 300, 150, 600],

    // silent: false → Ton explizit aktivieren (FCM override)
    silent: false,

    timestamp: Date.now(),

    data: {
      url:    url,
      chatId: data.chatId || null
    },

    actions: [
      { action: 'open',    title: '📋 Dashboard' },
      { action: 'dismiss', title: '✕ Schließen'  }
    ]
  };

  event.waitUntil(
    self.registration.showNotification(title, options)
      .catch(function(err) {
        // Fallback: minimale Notification ohne Actions (ältere Android)
        return self.registration.showNotification(title, {
          body:             body,
          icon:             '/icon-192.png',
          badge:            '/icon-72.png',
          requireInteraction: true,
          silent:           false,
          data:             { url: url }
        });
      })
  );
});

// ── Notification geklickt → Dashboard öffnen ─────────────────────────────────
self.addEventListener('notificationclick', function(event) {
  event.notification.close();

  if (event.action === 'dismiss') return;

  var notifData  = event.notification.data || {};
  var targetUrl  = notifData.url || '/admin';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(all) {
      // Offenes Admin-Tab suchen
      var adminTab = null;
      for (var i = 0; i < all.length; i++) {
        if (all[i].url.indexOf('/admin') !== -1) {
          adminTab = all[i];
          break;
        }
      }

      if (adminTab) {
        // Tab focussieren + ggf. zur richtigen Seite navigieren
        return adminTab.focus().then(function() {
          if (targetUrl !== adminTab.url && 'navigate' in adminTab) {
            return adminTab.navigate(targetUrl);
          }
        });
      }

      // Kein Tab offen → neues Fenster
      return clients.openWindow(targetUrl);
    })
  );
});

// ── pushsubscriptionchange: Token automatisch erneuern ───────────────────────
// Browser erneuert den Push-Endpoint alle paar Wochen. Ohne dieses Event
// kommt kein Push mehr an weil der Server mit altem Endpoint weiter sendet.
self.addEventListener('pushsubscriptionchange', function(event) {
  event.waitUntil((async function() {
    try {
      var oldEndpoint = (event.oldSubscription && event.oldSubscription.endpoint) || null;

      var vapidRes = await fetch('/api/admin/push/public-vapid');
      if (!vapidRes.ok) {
        console.warn('[SW] pushsubscriptionchange: VAPID-Key Fetch fehlgeschlagen', vapidRes.status);
        return;
      }
      var vapidData = await vapidRes.json();
      if (!vapidData.publicKey) return;

      var keyBytes = _urlBase64ToUint8Array(vapidData.publicKey);
      var newSub   = await self.registration.pushManager.subscribe({
        userVisibleOnly:      true,
        applicationServerKey: keyBytes
      });

      await fetch('/api/admin/push/renew', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ oldEndpoint: oldEndpoint, subscription: newSub.toJSON() })
      });
      console.log('[SW] pushsubscriptionchange: erfolgreich erneuert');
    } catch (err) {
      console.error('[SW] pushsubscriptionchange fehlgeschlagen:', err);
    }
  })());
});

// ── Hilfsfunktion: VAPID Base64 → Uint8Array ─────────────────────────────────
function _urlBase64ToUint8Array(base64String) {
  var padding = '='.repeat((4 - base64String.length % 4) % 4);
  var base64  = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  var raw     = self.atob(base64);
  var out     = new Uint8Array(raw.length);
  for (var i = 0; i < raw.length; ++i) out[i] = raw.charCodeAt(i);
  return out;
}
