// ==UserScript==
// @name         Steam Wishlist Copy (Fixed)
// @namespace    https://greasyfork.org/
// @version      1.0
// @description  Copy another user's Steam wishlist to your own account. Navigate to someone's wishlist page and click the button.
// @author       Fixed version (based on sffxzzp's original)
// @match        *://store.steampowered.com/wishlist/*
// @icon         https://store.steampowered.com/favicon.ico
// @grant        GM_xmlhttpRequest
// @connect      store.steampowered.com
// @connect      steamcommunity.com
// @connect      api.steampowered.com
// ==/UserScript==

(function () {
    'use strict';

    // ─── Helpers ────────────────────────────────────────────────────────────────

    function getCookie(name) {
        const match = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
        return match ? decodeURIComponent(match[1]) : null;
    }

    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    // ─── Get the SteamID64 from the current wishlist page URL ───────────────────
    // URL formats:
    //   store.steampowered.com/wishlist/profiles/76561198XXXXXXXXX/
    //   store.steampowered.com/wishlist/id/somevanityname/

    async function getSteamID64FromURL() {
        const path = window.location.pathname; // e.g. /wishlist/profiles/12345/ or /wishlist/id/name/

        // Direct SteamID64 in URL
        const profilesMatch = path.match(/\/wishlist\/profiles\/(\d{17})/);
        if (profilesMatch) {
            return profilesMatch[1];
        }

        // Vanity URL — resolve via steamcommunity XML feed
        const vanityMatch = path.match(/\/wishlist\/id\/([^/]+)/);
        if (vanityMatch) {
            const vanityName = vanityMatch[1];
            return new Promise((resolve, reject) => {
                GM_xmlhttpRequest({
                    method: 'GET',
                    url: `https://steamcommunity.com/id/${vanityName}/?xml=1`,
                    onload: function (response) {
                        const match = response.responseText.match(/<steamID64>(\d+)<\/steamID64>/);
                        if (match) {
                            resolve(match[1]);
                        } else {
                            reject('Could not resolve vanity URL to SteamID64.');
                        }
                    },
                    onerror: () => reject('Network error while resolving vanity URL.')
                });
            });
        }

        throw new Error('Could not determine SteamID64 from the URL: ' + path);
    }

    // ─── Fetch ALL wishlist pages for a given SteamID64 ─────────────────────────
    // Steam returns up to 100 items per page. We loop until we get an empty page.

    async function fetchFullWishlist(steamID64) {
        // The old /wishlistdata/ endpoint stopped working in November 2024.
        // The new official endpoint is IWishlistService/GetWishlist/v1.
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'GET',
                url: `https://api.steampowered.com/IWishlistService/GetWishlist/v1?steamid=${steamID64}`,
                headers: { 'Accept': 'application/json, text/plain, */*' },
                onload: function (response) {
                    const raw = response.responseText.trim();

                    if (!raw || raw.startsWith('<')) {
                        reject(
                            'Steam returned an unexpected response.\n\n' +
                            'This usually means:\n' +
                            '\u2022 This wishlist is set to Private\n' +
                            '\u2022 You are not logged in to Steam\n\n' +
                            'Response preview:\n' + raw.substring(0, 200)
                        );
                        return;
                    }

                    try {
                        const json = JSON.parse(raw);
                        // Response format: { "response": { "items": [ { "appid": 123, ... }, ... ] } }
                        const items = json && json.response && json.response.items;
                        if (!items || items.length === 0) {
                            resolve([]);
                            return;
                        }
                        resolve(items.map(item => item.appid));
                    } catch (e) {
                        reject(
                            'Could not parse Steam response.\n\n' +
                            'First 300 chars:\n' + raw.substring(0, 300)
                        );
                    }
                },
                onerror: () => reject('Network error while fetching wishlist.')
            });
        });
    }

    // ─── Add a single app to YOUR wishlist ──────────────────────────────────────

    async function addToWishlist(appid, sessionID) {
        return new Promise((resolve) => {
            GM_xmlhttpRequest({
                method: 'POST',
                url: 'https://store.steampowered.com/api/addtowishlist',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                data: `sessionid=${encodeURIComponent(sessionID)}&appid=${appid}`,
                onload: function (response) {
                    try {
                        const json = JSON.parse(response.responseText);
                        resolve(json.success === true);
                    } catch (e) {
                        resolve(false);
                    }
                },
                onerror: () => resolve(false)
            });
        });
    }

    // ─── UI: create a floating panel that is always visible ─────────────────────
    // Using a fixed-position element means we don't depend on Steam's DOM
    // structure at all — it will always appear regardless of layout changes.

    function createFloatingUI() {
        const panel = document.createElement('div');
        panel.id = 'swc-panel';
        Object.assign(panel.style, {
            position:     'fixed',
            bottom:       '24px',
            right:        '24px',
            zIndex:       '999999',
            background:   '#1b2838',
            border:       '1px solid #4c6b22',
            borderRadius: '6px',
            padding:      '12px 16px',
            boxShadow:    '0 4px 16px rgba(0,0,0,0.6)',
            fontFamily:   '"Motiva Sans", Arial, sans-serif',
            display:      'flex',
            flexDirection:'column',
            alignItems:   'center',
            gap:          '8px',
            minWidth:     '210px',
        });

        const title = document.createElement('div');
        title.textContent = '🎮 Wishlist Copier';
        Object.assign(title.style, {
            color:      '#c6d4df',
            fontSize:   '12px',
            fontWeight: 'bold',
            letterSpacing: '0.5px',
            textTransform: 'uppercase',
            marginBottom: '2px',
        });

        const btn = document.createElement('button');
        btn.id = 'swc-copy-btn';
        btn.textContent = '📋 Copy Wishlist to Mine';
        Object.assign(btn.style, {
            padding:      '7px 14px',
            background:   '#4c6b22',
            color:        '#c6d4df',
            border:       '1px solid #a4d007',
            borderRadius: '3px',
            cursor:       'pointer',
            fontSize:     '13px',
            fontWeight:   'bold',
            width:        '100%',
        });
        btn.onmouseenter = () => btn.style.background = '#5a7a28';
        btn.onmouseleave = () => btn.style.background = '#4c6b22';

        const statusLabel = document.createElement('div');
        statusLabel.id = 'swc-status';
        Object.assign(statusLabel.style, {
            color:     '#8f98a0',
            fontSize:  '11px',
            textAlign: 'center',
            minHeight: '14px',
        });

        panel.appendChild(title);
        panel.appendChild(btn);
        panel.appendChild(statusLabel);
        document.body.appendChild(panel);

        return { btn, statusLabel };
    }

    // ─── Main logic (runs on button click) ──────────────────────────────────────

    async function runCopy(btn, statusLabel) {
        const sessionID = getCookie('sessionid');
        if (!sessionID) {
            alert('Could not find your Steam session cookie.\nMake sure you are logged in to Steam in this browser.');
            return;
        }

        // Don't copy your own wishlist
        const currentPath = window.location.pathname;
        if (currentPath.includes('/wishlist/profiles/') || currentPath.includes('/wishlist/id/')) {
            // We're on someone else's (or our own) wishlist — that's fine
        }

        btn.disabled = true;
        btn.textContent = '⏳ Loading wishlist…';
        statusLabel.textContent = '';

        let steamID64, appIDs;

        try {
            steamID64 = await getSteamID64FromURL();
        } catch (e) {
            alert('Error resolving profile: ' + e);
            btn.disabled = false;
            btn.textContent = '📋 Copy Wishlist to Mine';
            return;
        }

        if (!confirm(`Found profile: ${steamID64}\n\nThis will add all their wishlisted games to YOUR account's wishlist.\n\nContinue?`)) {
            btn.disabled = false;
            btn.textContent = '📋 Copy Wishlist to Mine';
            return;
        }

        try {
            statusLabel.textContent = 'Fetching wishlist data…';
            appIDs = await fetchFullWishlist(steamID64);
        } catch (e) {
            alert('Error fetching wishlist: ' + e);
            btn.disabled = false;
            btn.textContent = '📋 Copy Wishlist to Mine';
            statusLabel.textContent = '';
            return;
        }

        if (appIDs.length === 0) {
            alert('This wishlist appears to be empty or private.');
            btn.disabled = false;
            btn.textContent = '📋 Copy Wishlist to Mine';
            statusLabel.textContent = '';
            return;
        }

        const total = appIDs.length;
        let added = 0, failed = 0;

        btn.textContent = '⏳ Adding games…';

        for (let i = 0; i < total; i++) {
            const appid = appIDs[i];
            const success = await addToWishlist(appid, sessionID);
            if (success) added++; else failed++;

            statusLabel.textContent = `${i + 1} / ${total} processed…`;

            // Delay between requests to avoid Steam rate-limiting you.
            // 800ms ≈ ~75 games/minute — safe and steady.
            await sleep(800);
        }

        btn.textContent = '✅ Done!';
        statusLabel.textContent = `Added: ${added} | Skipped/Failed: ${failed}`;
        alert(`Finished!\n\nSuccessfully added: ${added} game(s)\nSkipped or already on wishlist: ${failed} game(s)`);
    }

    // ─── Inject the floating panel when the page is ready ───────────────────────
    // We use a fixed-position panel so we don't depend on Steam's DOM at all.

    function inject() {
        if (document.getElementById('swc-panel')) return; // already injected
        if (!document.body) return;

        const { btn, statusLabel } = createFloatingUI();
        btn.onclick = () => runCopy(btn, statusLabel);
    }

    if (document.readyState === 'complete' || document.readyState === 'interactive') {
        inject();
    } else {
        document.addEventListener('DOMContentLoaded', inject);
    }

})();
