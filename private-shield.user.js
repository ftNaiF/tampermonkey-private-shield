// ==UserScript==
// @name         🔒 Tampermonkey Private Shield
// @namespace    https://github.com/mooh971/tampermonkey-private-shield
// @version      1.4.0
// @description  Auto-hide emails, phone numbers, IPs on any webpage during screensharing
// @author       mooh971
// @match        *://*/*
// @grant        GM_addStyle
// @grant        GM_addElement
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        unsafeWindow
// @sandbox      JavaScript
// @run-at       document-start
// @updateURL    https://raw.githubusercontent.com/mooh971/tampermonkey-private-shield/main/private-shield.user.js
// @downloadURL  https://raw.githubusercontent.com/mooh971/tampermonkey-private-shield/main/private-shield.user.js
// ==/UserScript==

/* global exportFunction */
(function () {
    'use strict';

    // -------------------------------------------------------------------------
    // 1. Constants & Global State
    // -------------------------------------------------------------------------
    const PATTERN = /([^\s,،<>]+@[^\s,،<>]+)|((?<![0-9٠-٩۰-۹.,٫])[0-9٠-٩۰-۹]{1,3}(?:[\u200e\u200f\u202a-\u202e\u2066-\u2069\u200c\u200d\s]*\.[\u200e\u200f\u202a-\u202e\u2066-\u2069\u200c\u200d\s]*[0-9٠-٩۰-۹]{1,3}){3}(?::[0-9٠-٩۰-۹]{1,5})?(?![0-9٠-٩۰-۹.,٫]))|((?<![0-9٠-٩۰-۹.,٫])(?:(?:\+|00|٠٠|۰۰)[ \u200e\u200f\u202a-\u202e\u2066-\u2069\u200c\u200d]*)?[0-9٠-٩۰-۹](?:[ \t\-.()[\u200e\u200f\u202a-\u202e\u2066-\u2069\u200c\u200d]{0,2}[0-9٠-٩۰-۹]){6,14}(?![0-9٠-٩0-9]))|((?:\[?)(?::(?::[0-9a-fA-F]{1,4}){1,7}|[0-9a-fA-F]{1,4}(?::[0-9a-fA-F]{0,4}){2,})(?:%[\w.\-]+)?(?:\])?(?::\d{1,5})?)/g;

    const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'INPUT', 'HEAD', 'LINK', 'META', 'TEMPLATE', 'IFRAME', 'SVG']);
    const tooltipText = 'Click to reveal 🔒';

    const CSS_RULES = `
        .ps-hidden {
            cursor: pointer !important;
            display: inline-block !important;
            padding: 0 4px !important;
            border-radius: 4px !important;
            border: 1px dashed rgba(0,105,111,0.5) !important;
            background: rgba(0,105,111,0.08) !important;
            color: transparent !important;
            text-shadow: 0 0 6px rgba(0,0,0,0.55) !important;
            filter: none !important;
            user-select: none !important;
            transition: all 0.15s ease-in-out !important;
        }
        .ps-visible {
            cursor: pointer !important;
            display: inline-block !important;
            padding: 0 4px !important;
            border-radius: 4px !important;
            border: 1px solid rgba(0,105,111,0.5) !important;
            background: rgba(0,105,111,0.06) !important;
            color: #01696f !important;
            font-weight: 600 !important;
            text-shadow: none !important;
            filter: none !important;
            user-select: auto !important;
            transition: all 0.15s ease-in-out !important;
        }
    `;

    const processed = new WeakSet();
    const pendingShadowRoots = [];
    let globalObserver = null;
    let currentSettings = null;

    // -------------------------------------------------------------------------
    // 1b. Settings (GM_getValue/GM_setValue)
    // -------------------------------------------------------------------------

    const DEFAULT_SETTINGS = {
        maskEmails: true,
        maskPhones: true,
        maskIPs: true,
        whitelistedSites: ''
    };

    function loadSettings() {
        return {
            maskEmails: GM_getValue('maskEmails', DEFAULT_SETTINGS.maskEmails),
            maskPhones: GM_getValue('maskPhones', DEFAULT_SETTINGS.maskPhones),
            maskIPs: GM_getValue('maskIPs', DEFAULT_SETTINGS.maskIPs),
            whitelistedSites: GM_getValue('whitelistedSites', DEFAULT_SETTINGS.whitelistedSites)
        };
    }

    function getSettings() {
        if (!currentSettings) currentSettings = loadSettings();
        return currentSettings;
    }

    function saveSettings(settings) {
        currentSettings = settings;
        GM_setValue('maskEmails', settings.maskEmails);
        GM_setValue('maskPhones', settings.maskPhones);
        GM_setValue('maskIPs', settings.maskIPs);
        GM_setValue('whitelistedSites', settings.whitelistedSites);
    }

    function isSiteWhitelisted() {
        const s = getSettings();
        if (!s.whitelistedSites) return false;
        const hostname = window.location.hostname.toLowerCase();
        return s.whitelistedSites.split(',').map(x => x.trim().toLowerCase()).filter(Boolean).some(site => {
            if (!site) return false;
            if (site === hostname) return true;
            if (site.startsWith('*.')) {
                const domain = site.slice(2);
                return hostname === domain || hostname.endsWith('.' + domain);
            }
            return false;
        });
    }

    // -------------------------------------------------------------------------
    // 2. Initialization
    // -------------------------------------------------------------------------
    hookAttachShadow();
    setupStyles();

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    // -------------------------------------------------------------------------
    // 3. Shadow DOM Support
    // -------------------------------------------------------------------------

    function injectStyles(root) {
        if (!root || root.querySelector?.('style.ps-styles')) return;
        if (typeof GM_addElement !== 'undefined') {
            GM_addElement(root, 'style', { class: 'ps-styles', textContent: CSS_RULES });
        } else {
            const style = document.createElement('style');
            style.className = 'ps-styles';
            style.textContent = CSS_RULES;
            root.appendChild(style);
        }
    }

    function hookAttachShadow() {
        const win = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
        const originalAttachShadow = win.Element?.prototype?.attachShadow;
        if (!originalAttachShadow) return;

        const patchedAttachShadow = function (init) {
            const shadowRoot = originalAttachShadow.call(this, init);
            try {
                injectStyles(shadowRoot);
                scanRoot(shadowRoot);
                if (globalObserver) {
                    globalObserver.observe(shadowRoot, { childList: true, subtree: true, characterData: true });
                } else {
                    pendingShadowRoots.push(shadowRoot);
                }
            } catch (e) { }
            return shadowRoot;
        };

        if (typeof exportFunction !== 'undefined') {
            exportFunction(patchedAttachShadow, win.Element.prototype, { defineAs: 'attachShadow' });
        } else {
            win.Element.prototype.attachShadow = patchedAttachShadow;
        }
    }

    // -------------------------------------------------------------------------
    // 4. Styles & Badge
    // -------------------------------------------------------------------------

    function setupStyles() {
        const badgeCss = `
            #ps-badge {
                position: fixed !important;
                bottom: 8px !important;
                right: 8px !important;
                z-index: 2147483647 !important;
                padding: 2px 6px !important;
                border-radius: 4px !important;
                border: none !important;
                background: rgba(0, 0, 0, 0.55) !important;
                box-shadow: 0 1px 4px rgba(0,0,0,0.2) !important;
                color: rgba(255, 255, 255, 0.85) !important;
                font-family: system-ui, -apple-system, sans-serif !important;
                font-size: 10px !important;
                white-space: nowrap !important;
                cursor: pointer !important;
                transition: opacity 0.3s ease, transform 0.3s ease !important;
            }
            #ps-badge:hover { background: rgba(0, 0, 0, 0.75) !important; color: #fff !important; }
            #ps-badge.ps-out { opacity: 0 !important; transform: translateY(4px) !important; pointer-events: none !important; }
            #ps-settings { position: fixed; top: 0; left: 0; width: 100%; height: 100%; z-index: 2147483646; display: flex; align-items: center; justify-content: center; font-family: system-ui, sans-serif; }
            #ps-settings .ps-backdrop { position: absolute; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.35); }
            #ps-settings .ps-modal { position: relative; background: #fff; border-radius: 8px; padding: 20px 24px; min-width: 300px; max-width: 400px; box-shadow: 0 4px 20px rgba(0,0,0,0.25); color: #222; font-size: 13px; }
            #ps-settings h3 { margin: 0 0 14px 0; font-size: 15px; }
            #ps-settings .ps-row { display: flex; align-items: center; justify-content: space-between; padding: 6px 0; }
            #ps-settings .ps-row + .ps-row { border-top: 1px solid #eee; }
            #ps-settings .ps-row input[type="checkbox"] { width: 16px; height: 16px; cursor: pointer; }
            #ps-settings .ps-row input[type="text"] { width: 100%; margin-top: 4px; padding: 4px 6px; border: 1px solid #ccc; border-radius: 4px; font-size: 12px; box-sizing: border-box; }
            #ps-settings .ps-buttons { display: flex; gap: 8px; justify-content: flex-end; margin-top: 14px; }
            #ps-settings .ps-buttons button { padding: 6px 14px; border: none; border-radius: 4px; cursor: pointer; font-size: 12px; }
            #ps-settings .ps-btn-primary { background: #01696f; color: #fff; }
            #ps-settings .ps-btn-primary:hover { background: #015558; }
            #ps-settings .ps-btn-cancel { background: #e0e0e0; color: #333; }
            #ps-settings .ps-btn-cancel:hover { background: #d0d0d0; }
        `;
        const css = CSS_RULES + badgeCss;

        if (typeof GM_addStyle !== 'undefined') GM_addStyle(css);
        else if (typeof GM_addElement !== 'undefined') GM_addElement('style', { textContent: css });
        else {
            (document.head || document.documentElement).appendChild(
                Object.assign(document.createElement('style'), { textContent: css })
            );
        }
    }

    function createBadge() {
        if (document.getElementById('ps-badge')) return;
        const badge = document.createElement('div');
        badge.id = 'ps-badge';

        const label = document.createElement('span');
        badge.appendChild(label);

        const gear = document.createElement('span');
        gear.textContent = ' ⚙';
        gear.style.opacity = '0.5';
        gear.style.fontSize = '9px';
        gear.style.marginLeft = '2px';
        gear.title = 'Settings';
        gear.addEventListener('click', e => {
            e.stopPropagation();
            createSettingsPanel();
        });
        badge.appendChild(gear);

        let allVisible = false;

        label.addEventListener('click', () => {
            allVisible = !allVisible;
            document.querySelectorAll('.ps-hidden, .ps-visible').forEach(el => {
                el.className = allVisible ? 'ps-visible' : 'ps-hidden';
                toggleElementMask(el, allVisible);
            });
            refreshBadge();
        });

        badge.addEventListener('mouseenter', () => { clearTimeout(window._psTimer); badge.classList.remove('ps-out'); });
        badge.addEventListener('mouseleave', () => { window._psTimer = setTimeout(() => badge.classList.add('ps-out'), 1500); });

        document.body.appendChild(badge);
        refreshBadge();
    }

    function refreshBadge() {
        const badge = document.getElementById('ps-badge');
        if (!badge) return;
        const label = badge.querySelector('span');
        const total = document.querySelectorAll('.ps-hidden, .ps-visible').length;
        if (label) label.textContent = '🔒 ' + total;
        clearTimeout(window._psTimer);
        badge.classList.remove('ps-out');
        window._psTimer = setTimeout(() => badge.classList.add('ps-out'), 3000);
    }

    // -------------------------------------------------------------------------
    // 5. MutationObserver
    // -------------------------------------------------------------------------

    function setupObserver() {
        globalObserver = new MutationObserver(mutations => {
            if (!document.getElementById('ps-badge') && document.body) createBadge();

            const nodesToScan = new Set();
            const textNodesToMask = new Set();

            for (const { addedNodes, characterData, target } of mutations) {
                if (characterData && target.nodeType === 3) {
                    textNodesToMask.add(target);
                } else {
                    for (const node of addedNodes) {
                        if (node.nodeType === 1) nodesToScan.add(node);
                        else if (node.nodeType === 3) textNodesToMask.add(node);
                    }
                }
            }

            // Deduplicate: skip nodes whose ancestor is already in the set
            const rootsToScan = [...nodesToScan].filter(node => {
                let p = node.parentNode;
                while (p) {
                    if (nodesToScan.has(p)) return false;
                    p = p.parentNode;
                }
                return true;
            });

            textNodesToMask.forEach(maskNode);
            rootsToScan.forEach(node => {
                if (!SKIP_TAGS.has(node.tagName)) scanRoot(node);
            });
        });

        globalObserver.observe(document.documentElement ?? document.body, {
            childList: true,
            subtree: true,
            characterData: true
        });

        while (pendingShadowRoots.length > 0) {
            const shadowRoot = pendingShadowRoots.shift();
            try {
                globalObserver.observe(shadowRoot, { childList: true, subtree: true, characterData: true });
            } catch (e) { }
        }
    }

    // -------------------------------------------------------------------------
    // 6. Validation Helpers
    // -------------------------------------------------------------------------

    function toEnglishNumerals(str) {
        let result = '';
        for (let i = 0; i < str.length; i++) {
            const code = str.charCodeAt(i);
            if (code === 0x200e || code === 0x200f || code === 0x200c || code === 0x200d ||
                (code >= 0x202a && code <= 0x202e) ||
                (code >= 0x2066 && code <= 0x2069)) continue;
            if (code >= 1632 && code <= 1641) result += String.fromCharCode(code - 1584);
            else if (code >= 1776 && code <= 1785) result += String.fromCharCode(code - 1728);
            else result += str[i];
        }
        return result;
    }

    function generateDummyText(originalText) {
        let result = '';
        for (let i = 0; i < originalText.length; i++) {
            const code = originalText.charCodeAt(i);
            if ((code >= 65 && code <= 90) || (code >= 97 && code <= 122) ||
                (code >= 48 && code <= 57) ||
                (code >= 1632 && code <= 1641) || (code >= 1776 && code <= 1785)) {
                result += 'x';
            } else {
                result += originalText[i];
            }
        }
        return result;
    }

    function isEmail(text) {
        const str = text.trim();
        if (str.includes(' ')) return false;
        const parts = str.split('@');
        if (parts.length !== 2) return false;
        const [local, domain] = parts;
        if (!local || !domain) return false;

        for (let i = 0; i < local.length; i++) {
            const code = local.charCodeAt(i);
            if (!((code >= 65 && code <= 90) || (code >= 97 && code <= 122) ||
                (code >= 48 && code <= 57) ||
                code === 46 || code === 95 || code === 45 || code === 43)) return false;
        }
        for (let i = 0; i < domain.length; i++) {
            const code = domain.charCodeAt(i);
            if (!((code >= 65 && code <= 90) || (code >= 97 && code <= 122) ||
                (code >= 48 && code <= 57) || code === 46 || code === 45)) return false;
        }
        if (domain.includes('..') || domain.startsWith('.') || domain.endsWith('.')) return false;

        const domainParts = domain.split('.');
        if (domainParts.length < 2) return false;

        const tld = domainParts[domainParts.length - 1];
        if (tld.length < 2) return false;
        for (let i = 0; i < tld.length; i++) {
            const code = tld.charCodeAt(i);
            if (!((code >= 65 && code <= 90) || (code >= 97 && code <= 122))) return false;
        }

        const systemExtensions = new Set(['service', 'socket', 'device', 'target', 'mount', 'timer', 'slice', 'scope']);
        if (systemExtensions.has(tld.toLowerCase())) return false;

        return true;
    }

    function isIP(text) {
        const norm = toEnglishNumerals(text.replace(/\s+/g, '')).split(':')[0];
        const parts = norm.split('.');
        if (parts.length !== 4) return false;
        return parts.every(part => {
            if (!part || isNaN(part) || part.includes('e') || part.includes('+') || part.includes('-')) return false;
            const num = Number(part);
            if (num < 0 || num > 255) return false;
            if (part.length > 1 && part[0] === '0') return false;
            return true;
        });
    }

    function isIPv6(text) {
        let str = text.trim().replace(/^\[|\](?::\d{1,5})?$/g, '').split('%')[0].toLowerCase();
        if (!str || str.length < 2 || str.length > 39 || !str.includes(':')) return false;

        if (str.includes('.')) {
            const lastColon = str.lastIndexOf(':');
            if (lastColon < 0) return false;
            const ipv4Part = str.slice(lastColon + 1);
            if (!isIP(ipv4Part)) return false;
            const prefix = str.slice(0, lastColon);
            if (!prefix) return false;
            const groups = prefix.split(':').filter(g => g !== '');
            for (const g of groups) {
                if (!/^[0-9a-f]{1,4}$/.test(g)) return false;
            }
            if ((prefix.match(/::/g) || []).length > 1) return false;
            return true;
        }

        const colons = (str.match(/:/g) || []).length;
        if (colons < 2 || colons > 7) return false;

        const hasDC = str.includes('::');
        if (hasDC) {
            if ((str.match(/::/g) || []).length > 1) return false;
        } else if (colons !== 7) {
            return false;
        }

        if (str.startsWith(':') && !str.startsWith('::')) return false;
        if (str.endsWith(':') && !str.endsWith('::')) return false;

        const groups = str.split(':').filter(g => g !== '');
        for (const g of groups) {
            if (g.length > 4) return false;
            for (let i = 0; i < g.length; i++) {
                const code = g.charCodeAt(i);
                if (!((code >= 48 && code <= 57) || (code >= 97 && code <= 102))) return false;
            }
        }
        return true;
    }

    function isPhone(text) {
        const norm = toEnglishNumerals(text).trim();
        let digits = '';
        for (let i = 0; i < norm.length; i++) {
            const code = norm.charCodeAt(i);
            if (code >= 48 && code <= 57) digits += norm[i];
        }
        if (digits.length < 7 || digits.length > 15) return false;

        if (norm.startsWith('+')) return digits.length >= 9 && digits.length <= 15;
        if (norm.startsWith('00')) return !digits.startsWith('000') && digits.length >= 11 && digits.length <= 15;
        if (digits.startsWith('1')) return digits.length === 11;

        if (digits.length >= 11 && digits.length <= 14) {
            const p2 = digits.slice(0, 2);
            const p3 = digits.slice(0, 3);
            if (new Set(['20', '33', '44', '49', '90', '98']).has(p2)) return true;
            if (p3.startsWith('96') && p3[2] >= '1' && p3[2] <= '8') return true;
            if (p3.startsWith('97') && ['1', '3', '4'].includes(p3[2])) return true;
            if (p3.startsWith('21') && ['2', '3', '6', '8'].includes(p3[2])) return true;
            if (p3 === '249' || p3 === '880') return true;
        }
        if (digits.length >= 9 && digits.length <= 12 && digits[0] === '0' && '15679'.includes(digits[1])) return true;
        if (digits.length >= 9 && digits.length <= 10 && digits[0] >= '2' && digits[0] <= '9') return true;
        if (digits.length >= 11 && digits.length <= 12 && '0236789'.includes(digits[0])) return true;

        return false;
    }

    function isTime(text) {
        const norm = toEnglishNumerals(text.trim());
        const parts = norm.split(':');
        if (parts.length !== 2 && parts.length !== 3) return false;
        return parts.every((p, idx) => {
            if (p.length < 1 || p.length > 2 || isNaN(p)) return false;
            const val = Number(p);
            return idx === 0 ? (val >= 0 && val <= 23) : (p.length === 2 && val >= 0 && val <= 59);
        });
    }

    function isDate(text) {
        const norm = toEnglishNumerals(text.trim());
        const cleanNorm = norm.replace(/\//g, '-').replace(/\./g, '-');
        const parts = cleanNorm.split('-');

        if (parts.length === 3) {
            const isVal = (s, min, max) => {
                if (!s || isNaN(s) || s.includes('e') || s.includes('+') || s.includes('-')) return false;
                const n = Number(s);
                return n >= min && n <= max;
            };
            const isYear = s => {
                if (s.length !== 4 || isNaN(s)) return false;
                const n = Number(s);
                return (n >= 1900 && n <= 2099) || (n >= 1300 && n <= 1499);
            };
            const [p0, p1, p2] = parts;
            if ((isYear(p0) && isVal(p1, 1, 12) && isVal(p2, 1, 31)) ||
                (isVal(p0, 1, 31) && isVal(p1, 1, 12) && isYear(p2))) return true;
        }

        let digits = '';
        for (let i = 0; i < norm.length; i++) {
            const code = norm.charCodeAt(i);
            if (code >= 48 && code <= 57) digits += norm[i];
        }
        if (digits.length === 8 || digits.length === 10) {
            const y = parseInt(digits.slice(0, 4), 10);
            const m = parseInt(digits.slice(4, 6), 10);
            const d = parseInt(digits.slice(6, 8), 10);
            const validY = (y >= 1900 && y <= 2099) || (y >= 1300 && y <= 1499);
            const validM = m >= 1 && m <= 12;
            const validD = d >= 1 && d <= 31;
            if (digits.length === 8) return validY && validM && validD;
            const h = parseInt(digits.slice(8, 10), 10);
            return validY && validM && validD && h >= 0 && h <= 23;
        }
        return false;
    }

    function shouldMask(val) {
        const s = getSettings();
        if (val.includes('@')) return s.maskEmails && isEmail(val);
        if (isIP(val)) return s.maskIPs;
        if (val.includes(':') && isIPv6(val)) return s.maskIPs;
        if (isTime(val) || isDate(val)) return false;

        const normVal = toEnglishNumerals(val).trim();
        if (!s.maskPhones) return false;
        if (normVal.includes('/') || (normVal.includes('.') && normVal.includes('-'))) return false;

        if (normVal.includes('.')) {
            const parts = normVal.split('.');
            if (parts.length === 2) return false;
            const isPotentialPhone = normVal.startsWith('+') || normVal.startsWith('00');
            if (!isPotentialPhone) {
                if (parts.length > 3) return false;
                if (parts.length === 3 && parts.some(p => p.length === 1)) return false;
                if (parts.length > 2 && (parts[0] === '0' || parts[0] === '1')) return false;
            }
            const lastPart = parts.at(-1);
            let lastDigits = '';
            for (let i = 0; i < lastPart.length; i++) {
                const code = lastPart.charCodeAt(i);
                if (code >= 48 && code <= 57) lastDigits += lastPart[i];
            }
            if (lastDigits.length > 4) return false;
        }
        return isPhone(val);
    }

    function hasTargetData(text) {
        if (!text) return false;
        let hasDigitOrAt = false;
        for (let i = 0; i < text.length; i++) {
            const code = text.charCodeAt(i);
            if (code === 64 || (code >= 48 && code <= 57) ||
                (code >= 1632 && code <= 1641) || (code >= 1776 && code <= 1785)) {
                hasDigitOrAt = true;
                break;
            }
        }
        if (!hasDigitOrAt) return false;
        if (text.includes('@')) return true;

        const norm = toEnglishNumerals(text.replace(/\s+/g, ''));
        if (norm.includes('.') && norm.split('.').length >= 4) return true;

        if (norm.includes(':') && /[0-9a-fA-F]{1,4}(?::[0-9a-fA-F]{0,4}){2,}/.test(norm)) return true;

        let digitCount = 0;
        const phoneSeparators = new Set(['-', '.', '(', ')', ',', '،']);
        for (let i = 0; i < norm.length; i++) {
            const code = norm.charCodeAt(i);
            if (code >= 48 && code <= 57) {
                if (++digitCount >= 7) return true;
            } else if (!phoneSeparators.has(norm[i])) {
                digitCount = 0;
            }
        }
        return false;
    }

    // -------------------------------------------------------------------------
    // 7. Masking Core Logic
    // -------------------------------------------------------------------------

    function maskAttributes(el) {
        if (!el?.getAttribute) return;
        for (const attr of ['title', 'aria-label']) {
            const val = el.getAttribute(attr);
            if (val && hasTargetData(val)) {
                PATTERN.lastIndex = 0;
                if (PATTERN.test(val)) {
                    PATTERN.lastIndex = 0;
                    const masked = val.replace(PATTERN, m => shouldMask(m) ? '🔒' : m);
                    if (val !== masked) el.setAttribute(attr, masked);
                }
            }
        }
    }

    function toggleElementMask(element, showRealText) {
        if (showRealText) {
            element.removeAttribute('title');
            if (element.dataset.realText) element.textContent = element.dataset.realText;
        } else {
            element.setAttribute('title', tooltipText);
            if (element.dataset.dummyText) element.textContent = element.dataset.dummyText;
        }
    }

    function maskNode(node) {
        if (processed.has(node)) return;
        const parent = node.parentNode;
        if (!parent || processed.has(parent) || SKIP_TAGS.has(parent.tagName) || parent.isContentEditable) return;
        if (parent.classList?.contains('ssb-blur-wrapper') || parent.closest?.('.ps-hidden, .ps-visible, #ps-badge, head')) return;

        const text = node.textContent;
        if (!hasTargetData(text)) return;

        PATTERN.lastIndex = 0;
        const frag = document.createDocumentFragment();
        let last = 0, match, found = false;

        while ((match = PATTERN.exec(text)) !== null) {
            const val = match[0];
            if (!shouldMask(val)) continue;

            found = true;
            if (match.index > last) frag.appendChild(document.createTextNode(text.slice(last, match.index)));

            const span = document.createElement('span');
            span.className = 'ps-hidden';
            span.setAttribute('title', tooltipText);
            span.dataset.realText = val;
            span.dataset.dummyText = generateDummyText(val);
            span.textContent = span.dataset.dummyText;

            span.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                const isHidden = span.className === 'ps-hidden';
                span.className = isHidden ? 'ps-visible' : 'ps-hidden';
                toggleElementMask(span, isHidden);
                refreshBadge();
            });

            processed.add(span);
            frag.appendChild(span);
            last = match.index + val.length;
        }

        if (!found) return;
        if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));

        processed.add(node);
        node.replaceWith(frag);
    }

    function scanRoot(root) {
        if (!root) return;

        if (root.shadowRoot) {
            injectStyles(root.shadowRoot);
            scanRoot(root.shadowRoot);
            if (globalObserver) {
                try { globalObserver.observe(root.shadowRoot, { childList: true, subtree: true, characterData: true }); } catch (e) { }
            } else {
                pendingShadowRoots.push(root.shadowRoot);
            }
        }

        if (root.querySelectorAll) {
            root.querySelectorAll('[title], [aria-label]').forEach(maskAttributes);
        }

        const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
            acceptNode(n) {
                if (n.nodeType === Node.ELEMENT_NODE) {
                    if (SKIP_TAGS.has(n.tagName) || n.isContentEditable ||
                        n.classList?.contains('ps-hidden') || n.classList?.contains('ps-visible') ||
                        n.id === 'ps-badge') {
                        return NodeFilter.FILTER_REJECT;
                    }
                    if (n.shadowRoot) {
                        injectStyles(n.shadowRoot);
                        scanRoot(n.shadowRoot);
                        if (globalObserver) {
                            try { globalObserver.observe(n.shadowRoot, { childList: true, subtree: true, characterData: true }); } catch (e) { }
                        } else {
                            pendingShadowRoots.push(n.shadowRoot);
                        }
                    }
                    return NodeFilter.FILTER_SKIP;
                }
                // TEXT_NODE
                if (processed.has(n)) return NodeFilter.FILTER_REJECT;
                return hasTargetData(n.textContent) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
            }
        });

        const nodes = [];
        while (walker.nextNode()) nodes.push(walker.currentNode);
        nodes.forEach(maskNode);

        refreshBadge();
    }

    // -------------------------------------------------------------------------
    // 8. Settings Panel
    // -------------------------------------------------------------------------

    function createSettingsPanel() {
        const existing = document.getElementById('ps-settings');
        if (existing) existing.remove();

        const cur = getSettings();

        const panel = document.createElement('div');
        panel.id = 'ps-settings';
        panel.innerHTML = `
            <div class="ps-backdrop"></div>
            <div class="ps-modal">
                <h3>🔒 Private Shield Settings</h3>
                <div class="ps-row">
                    <span>Mask email addresses</span>
                    <input type="checkbox" id="ps-opt-emails" ${cur.maskEmails ? 'checked' : ''}>
                </div>
                <div class="ps-row">
                    <span>Mask phone numbers</span>
                    <input type="checkbox" id="ps-opt-phones" ${cur.maskPhones ? 'checked' : ''}>
                </div>
                <div class="ps-row">
                    <span>Mask IP addresses</span>
                    <input type="checkbox" id="ps-opt-ips" ${cur.maskIPs ? 'checked' : ''}>
                </div>
                <div class="ps-row" style="flex-wrap:wrap;">
                    <span style="width:100%;">Whitelisted sites (comma-separated)</span>
                    <input type="text" id="ps-opt-sites" value="${cur.whitelistedSites.replace(/"/g, '&quot;')}" placeholder="e.g. example.com, *.internal.com">
                </div>
                <div class="ps-buttons">
                    <button class="ps-btn-primary" id="ps-save">Save & Reload</button>
                    <button class="ps-btn-cancel" id="ps-cancel">Cancel</button>
                </div>
            </div>
        `;

        document.body.appendChild(panel);

        document.getElementById('ps-save').addEventListener('click', () => {
            saveSettings({
                maskEmails: document.getElementById('ps-opt-emails').checked,
                maskPhones: document.getElementById('ps-opt-phones').checked,
                maskIPs: document.getElementById('ps-opt-ips').checked,
                whitelistedSites: document.getElementById('ps-opt-sites').value
            });
            panel.remove();
            location.reload();
        });

        document.getElementById('ps-cancel').addEventListener('click', () => panel.remove());
        panel.querySelector('.ps-backdrop').addEventListener('click', () => panel.remove());
    }

    // -------------------------------------------------------------------------
    // 9. Entry Point
    // -------------------------------------------------------------------------

    function init() {
        if (isSiteWhitelisted()) return;
        createBadge();
        scanRoot(document.body);
        setupObserver();
        if (typeof GM_registerMenuCommand !== 'undefined') {
            GM_registerMenuCommand('🔒 Private Shield Settings', createSettingsPanel);
        }
    }

})();
