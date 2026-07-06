/**
 * push-config.js v2.0.12 — Robuster Web-Push Subscription Flow
 *
 * Schritt-für-Schritt mit klaren Fehlermeldungen an jedem Punkt.
 * Nutzt den Bearer-Token wie der Rest des Dashboards.
 */

function _pushToken() {
    return localStorage.getItem('admin_token') || '';
}

// Robuster API-Call mit Bearer-Token
async function _pushApi(endpoint, method, body) {
    var opts = {
        method: method || 'GET',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + _pushToken()
        }
    };
    if (body) opts.body = JSON.stringify(body);
    var r = await fetch('/api/admin' + endpoint, opts);
    var data = null;
    try { data = await r.json(); } catch(_) {}
    if (!r.ok) {
        var msg = (data && (data.error || data.message)) || ('HTTP ' + r.status);
        throw new Error(msg);
    }
    return data;
}

function _urlBase64ToUint8Array(base64String) {
    var padding = '='.repeat((4 - base64String.length % 4) % 4);
    var base64  = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    var rawData = window.atob(base64);
    var outputArray = new Uint8Array(rawData.length);
    for (var i = 0; i < rawData.length; ++i) outputArray[i] = rawData.charCodeAt(i);
    return outputArray;
}

function _setPushMsg(msg, color) {
    var el = document.getElementById('push-step-status');
    if (el) {
        el.style.display = 'block';
        el.style.color = color || '#94a3b8';
        el.textContent = msg;
    }
    if (typeof showToast === 'function') showToast(msg);
}

async function subscribePush() {
    return _doSubscribe(false);
}

// Gemeinsamer Subscribe-Kern. silent=true → keine UI-Meldungen (für Auto-Erneuerung).
async function _doSubscribe(silent) {
    var say = silent ? function(){} : _setPushMsg;

    if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
        say('❌ Dieser Browser unterstützt kein Push.', '#ef4444');
        return false;
    }

    try {
        // VAPID Public Key holen
        if (!silent) say('⏳ Lade VAPID-Key…');
        var keyData;
        try { keyData = await _pushApi('/vapid/public-key'); }
        catch (e) { say('❌ VAPID-Key konnte nicht geladen werden: ' + e.message, '#ef4444'); return false; }
        if (!keyData || !keyData.configured || !keyData.publicKey) {
            say('❌ VAPID-Keys nicht in Coolify gesetzt (VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY).', '#ef4444');
            return false;
        }

        // Permission anfragen (bei silent nur fortfahren wenn schon erlaubt)
        if (Notification.permission !== 'granted') {
            if (silent) return false;
            say('⏳ Frage Berechtigung an…');
            var permission = await Notification.requestPermission();
            if (permission !== 'granted') {
                say('❌ Benachrichtigungen wurden abgelehnt. In den Browser-/App-Einstellungen erlauben.', '#ef4444');
                return false;
            }
        }

        // Service Worker registrieren + bereit warten
        if (!silent) say('⏳ Registriere Service Worker…');
        await navigator.serviceWorker.register('/sw.js', { scope: '/' });
        var registration = await navigator.serviceWorker.ready;

        // Bestehende Subscription wiederverwenden wenn vorhanden, sonst neu anlegen.
        // (Bei Auto-Erneuerung NICHT unsubscriben — nur sicherstellen, dass eine existiert.)
        var subscription = await registration.pushManager.getSubscription();
        if (!subscription) {
            try {
                subscription = await registration.pushManager.subscribe({
                    userVisibleOnly: true,
                    applicationServerKey: _urlBase64ToUint8Array(keyData.publicKey)
                });
            } catch (subErr) {
                say('❌ Subscribe fehlgeschlagen: ' + subErr.message + ' — Brave: brave://settings/privacy → "Google-Dienste für Push-Nachrichten verwenden" aktivieren.', '#ef4444');
                return false;
            }
        }

        // Subscription am Server speichern (idempotent — Server dedupliziert per endpoint)
        if (!silent) say('⏳ Speichere Subscription…');
        await _pushApi('/push-subscription', 'POST', { subscription: subscription.toJSON ? subscription.toJSON() : subscription });

        if (!silent) {
            var status = await _pushApi('/push/status');
            if (status && status.subscriptions > 0) {
                say('✅ Push aktiv! ' + status.subscriptions + ' Gerät(e) registriert.', '#22c55e');
            } else {
                say('⚠️ Subscription gesendet, aber Server zeigt 0. Bitte "Test senden" klicken.', '#f59e0b');
            }
        }
        return true;
    } catch (e) {
        say('❌ Fehler: ' + (e.message || e), '#ef4444');
        return false;
    }
}

// ── Bombensichere Auto-Erneuerung ──────────────────────────────────────────
// Hält die Subscription dauerhaft frisch, auch wenn die WebApp lange im
// Hintergrund lief und der Push-Endpoint rotiert/abgelaufen ist.
var _lastPushRefresh = 0;
async function ensurePushFresh(force) {
    if (Notification.permission !== 'granted') return;
    var now = Date.now();
    if (!force && (now - _lastPushRefresh) < 60000) return; // max 1×/Minute
    _lastPushRefresh = now;
    try { await _doSubscribe(true); } catch (_) {}
}

function _initPushAutoRenew() {
    // 1. Beim Laden des Dashboards sofort sicherstellen
    ensurePushFresh(true);

    // 2. Sobald die App wieder in den Vordergrund kommt (entscheidend nach langem
    //    Hintergrund!) → Subscription neu validieren und am Server auffrischen
    document.addEventListener('visibilitychange', function() {
        if (document.visibilityState === 'visible') ensurePushFresh(true);
    });
    window.addEventListener('focus', function() { ensurePushFresh(false); });
    window.addEventListener('online', function() { ensurePushFresh(true); });

    // 3. Regelmäßige Auffrischung solange die App offen/sichtbar ist
    setInterval(function() {
        if (document.visibilityState === 'visible') ensurePushFresh(false);
    }, 4 * 60 * 1000); // alle 4 Minuten
}

document.addEventListener('DOMContentLoaded', function() {
    var btn = document.getElementById('enable-push');
    if (btn) btn.addEventListener('click', subscribePush);
    _initPushAutoRenew();
});
