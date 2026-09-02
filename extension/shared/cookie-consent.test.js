import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it } from 'vitest';
import { dismissCookieConsentOnPage } from './cookie-consent.js';

let dom;

afterEach(() => {
  dom?.window?.close();
  dom = undefined;
});

function installGlobals(html) {
  dom = new JSDOM(html, { url: 'https://www.leclercdrive.fr/', runScripts: 'outside-only' });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
}

describe('dismissCookieConsentOnPage', () => {
  it('clique le refus OneTrust en priorité', async () => {
    installGlobals(`<button id="onetrust-reject-all-handler">Tout refuser</button>`);
    const button = document.querySelector('#onetrust-reject-all-handler');
    let clicked = false;
    button.addEventListener('click', () => (clicked = true));

    await expect(dismissCookieConsentOnPage()).resolves.toEqual({ dismissed: true, mode: 'onetrust_reject' });
    expect(clicked).toBe(true);
  });

  it('clique un refus détecté par heuristique quand OneTrust est absent', async () => {
    installGlobals(`
      <div role="dialog" id="cookie-banner">
        <button>Tout refuser</button>
      </div>
    `);
    await expect(dismissCookieConsentOnPage()).resolves.toEqual({ dismissed: true, mode: 'heuristic_reject' });
  });

  // Audit sécurité du 30/08 (MEDIUM #7, choix explicite de l'utilisateur :
  // fail-closed strict). Avant ce correctif, ce cas cliquait "Tout accepter"
  // en silence.
  it("ne clique JAMAIS \"Tout accepter\" et signale CONSENT_REJECT_UNAVAILABLE quand seul l'accept est reconnu (OneTrust)", async () => {
    installGlobals(`<button id="onetrust-accept-btn-handler">Tout accepter</button>`);
    const button = document.querySelector('#onetrust-accept-btn-handler');
    let clicked = false;
    button.addEventListener('click', () => (clicked = true));

    await expect(dismissCookieConsentOnPage()).resolves.toEqual({ dismissed: false, code: 'CONSENT_REJECT_UNAVAILABLE' });
    expect(clicked).toBe(false);
  });

  it("ne clique JAMAIS \"Tout accepter\" et signale CONSENT_REJECT_UNAVAILABLE quand seul l'accept est reconnu (heuristique)", async () => {
    installGlobals(`
      <div role="dialog" id="cookie-banner">
        <button>Tout accepter</button>
      </div>
    `);
    const button = document.querySelector('button');
    let clicked = false;
    button.addEventListener('click', () => (clicked = true));

    await expect(dismissCookieConsentOnPage()).resolves.toEqual({ dismissed: false, code: 'CONSENT_REJECT_UNAVAILABLE' });
    expect(clicked).toBe(false);
  });

  it("renvoie dismissed:false sans code quand aucune bannière n'est présente du tout", async () => {
    installGlobals(`<main><h1>Recherche</h1></main>`);
    await expect(dismissCookieConsentOnPage()).resolves.toEqual({ dismissed: false });
  });
});
