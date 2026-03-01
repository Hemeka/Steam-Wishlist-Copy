// ==UserScript==
// @name         Steam Wishlist Remover
// @namespace    https://greasyfork.org/
// @version      1.0
// @description  Remove all (or selected) games from your own Steam wishlist. Only works on your own wishlist page.
// @author       Custom script
// @match        *://store.steampowered.com/wishlist/*
// @icon         https://store.steampowered.com/favicon.ico
// @grant        GM_xmlhttpRequest
// @connect      store.steampowered.com
// @connect      api.steampowered.com
// @connect      steamcommunity.com
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

    // ─── Get your own SteamID64 from the steamLoginSecure cookie ────────────────
    // Format is: "76561198XXXXXXXXX||<token>"

    function getOwnSteamID64() {
        const cookie = getCookie('steamLoginSecure');
        if (!cookie) return null;
        const match = cookie.match(/^(\d{17})/);
        return match ? match[1] : null;
    }

    // ─── Get SteamID64 of the profile whose wishlist page we're on ──────────────

    async function getPageSteamID64() {
        const path = window.location.pathname;

        const profilesMatch = path.match(/\/wishlist\/profiles\/(\d{17})/);
        if (profilesMatch) return profilesMatch[1];

        const vanityMatch = path.match(/\/wishlist\/id\/([^/]+)/);
        if (vanityMatch) {
            const vanityName = vanityMatch[1];
            return new Promise((resolve, reject) => {
                GM_xmlhttpRequest({
                    method: 'GET',
                    url: `https://steamcommunity.com/id/${vanityName}/?xml=1`,
                    onload: function (response) {
                        const match = response.responseText.match(/<steamID64>(\d+)<\/steamID64>/);
                        if (match) resolve(match[1]);
                        else reject('Could not resolve vanity URL to SteamID64.');
                    },
                    onerror: () => reject('Network error resolving vanity URL.')
                });
            });
        }

        throw new Error('Could not determine SteamID64 from URL: ' + path);
    }

    // ─── Fetch your full wishlist from Steam's API ───────────────────────────────

    async function fetchWishlist(steamID64) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'GET',
                url: `https://api.steampowered.com/IWishlistService/GetWishlist/v1?steamid=${steamID64}`,
                headers: { 'Accept': 'application/json' },
                onload: function (response) {
                    const raw = response.responseText.trim();
                    if (!raw || raw.startsWith('<')) {
                        reject('Steam returned an unexpected response. Is the wishlist private?');
                        return;
                    }
                    try {
                        const json = JSON.parse(raw);
                        const items = json && json.response && json.response.items;
                        resolve(items ? items.map(i => i.appid) : []);
                    } catch (e) {
                        reject('Could not parse Steam response:\n' + raw.substring(0, 300));
                    }
                },
                onerror: () => reject('Network error fetching wishlist.')
            });
        });
    }

    // ─── Remove a single app from your wishlist ──────────────────────────────────

    async function removeFromWishlist(appid, sessionID) {
        return new Promise((resolve) => {
            GM_xmlhttpRequest({
                method: 'POST',
                url: 'https://store.steampowered.com/api/removefromwishlist',
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

    // ─── Floating UI ────────────────────────────────────────────────────────────

    function createFloatingUI() {
        const panel = document.createElement('div');
        panel.id = 'swr-panel';
        Object.assign(panel.style, {
            position:      'fixed',
            bottom:        '24px',
            left:          '24px',
            zIndex:        '999999',
            background:    '#1b2838',
            border:        '1px solid #922020',
            borderRadius:  '6px',
            padding:       '12px 16px',
            boxShadow:     '0 4px 16px rgba(0,0,0,0.6)',
            fontFamily:    '"Motiva Sans", Arial, sans-serif',
            display:       'flex',
            flexDirection: 'column',
            alignItems:    'center',
            gap:           '8px',
            minWidth:      '220px',
        });

        const title = document.createElement('div');
        title.textContent = '🗑️ Wishlist Remover';
        Object.assign(title.style, {
            color:         '#c6d4df',
            fontSize:      '12px',
            fontWeight:    'bold',
            letterSpacing: '0.5px',
            textTransform: 'uppercase',
            marginBottom:  '2px',
        });

        const btn = document.createElement('button');
        btn.id = 'swr-remove-btn';
        btn.textContent = '🗑️ Remove All From My Wishlist';
        Object.assign(btn.style, {
            padding:      '7px 14px',
            background:   '#6b2222',
            color:        '#c6d4df',
            border:       '1px solid #c02020',
            borderRadius: '3px',
            cursor:       'pointer',
            fontSize:     '13px',
            fontWeight:   'bold',
            width:        '100%',
        });
        btn.onmouseenter = () => btn.style.background = '#7a2828';
        btn.onmouseleave = () => btn.style.background = '#6b2222';

        const statusLabel = document.createElement('div');
        statusLabel.id = 'swr-status';
        Object.assign(statusLabel.style, {
            color:     '#8f98a0',
            fontSize:  '11px',
            textAlign: 'center',
            minHeight: '14px',
        });

        const warning = document.createElement('div');
        warning.textContent = '⚠️ Only works on your own wishlist';
        Object.assign(warning.style, {
            color:     '#8f98a0',
            fontSize:  '10px',
            textAlign: 'center',
        });

        panel.appendChild(title);
        panel.appendChild(btn);
        panel.appendChild(statusLabel);
        panel.appendChild(warning);
        document.body.appendChild(panel);

        return { btn, statusLabel };
    }

    // ─── Main logic ─────────────────────────────────────────────────────────────

    async function runRemove(btn, statusLabel) {
        const sessionID = getCookie('sessionid');
        if (!sessionID) {
            alert('Could not find your Steam session cookie.\nMake sure you are logged in to Steam in this browser.');
            return;
        }

        const ownID = getOwnSteamID64();
        let pageID;

        try {
            pageID = await getPageSteamID64();
        } catch (e) {
            alert('Error reading page URL: ' + e);
            return;
        }

        // Safety check: only allow removal on your OWN wishlist
        if (ownID && pageID && ownID !== pageID) {
            alert(
                "⚠️ This is someone else's wishlist, not yours!\n\n" +
                "The Wishlist Remover only works on your own wishlist.\n\n" +
                "Navigate to your own wishlist first:\n" +
                "store.steampowered.com/wishlist/profiles/" + ownID + "/"
            );
            return;
        }

        btn.disabled = true;
        btn.textContent = '⏳ Fetching your wishlist…';
        statusLabel.textContent = '';

        let appIDs;
        try {
            statusLabel.textContent = 'Fetching wishlist data…';
            appIDs = await fetchWishlist(pageID);
        } catch (e) {
            alert('Error fetching wishlist:\n' + e);
            btn.disabled = false;
            btn.textContent = '🗑️ Remove All From My Wishlist';
            statusLabel.textContent = '';
            return;
        }

        if (appIDs.length === 0) {
            alert('Your wishlist appears to be empty or private.');
            btn.disabled = false;
            btn.textContent = '🗑️ Remove All From My Wishlist';
            statusLabel.textContent = '';
            return;
        }

        const total = appIDs.length;

        if (!confirm(
            `Found ${total} game(s) on your wishlist.\n\n` +
            `⚠️ This will permanently remove ALL of them from your wishlist!\n\n` +
            `This cannot be undone. Are you absolutely sure?`
        )) {
            btn.disabled = false;
            btn.textContent = '🗑️ Remove All From My Wishlist';
            return;
        }

        let removed = 0, failed = 0;
        btn.textContent = '⏳ Removing games…';

        for (let i = 0; i < total; i++) {
            const appid = appIDs[i];
            const success = await removeFromWishlist(appid, sessionID);
            if (success) removed++; else failed++;

            statusLabel.textContent = `${i + 1} / ${total} processed…`;

            // 800ms delay to stay within Steam's rate limit
            await sleep(300);
        }

        btn.textContent = '✅ Done!';
        statusLabel.textContent = `Removed: ${removed} | Failed: ${failed}`;
        alert(
            `Finished!\n\n` +
            `Successfully removed: ${removed} game(s)\n` +
            `Failed: ${failed} game(s)`
        );
    }

    // ─── Inject panel ───────────────────────────────────────────────────────────

    function inject() {
        if (document.getElementById('swr-panel')) return;
        if (!document.body) return;

        const { btn, statusLabel } = createFloatingUI();
        btn.onclick = () => runRemove(btn, statusLabel);
    }

    if (document.readyState === 'complete' || document.readyState === 'interactive') {
        inject();
    } else {
        document.addEventListener('DOMContentLoaded', inject);
    }

})();
