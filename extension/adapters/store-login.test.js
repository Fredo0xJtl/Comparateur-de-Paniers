// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openStoreLoginOnPage as openLeclerc } from './leclerc/leclerc-collector.js';
import { openStoreLoginOnPage as openCoursesU } from './courses-u/courses-u-collector.js';

// Les deux copies (fonctions injectées, donc autonomes) doivent se comporter
// pareil : ouvrir l'écran de connexion du site, sans jamais toucher aux champs.
describe.each([
  ['Leclerc', openLeclerc],
  ['Courses U', openCoursesU]
])('openStoreLoginOnPage (%s)', (_label, openLogin) => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('clique sur le bouton « Se connecter » visible', () => {
    document.body.innerHTML = '<button id="b">Se connecter</button><a href="/deconnexion">Déconnexion</a>';
    const button = document.getElementById('b');
    button.getClientRects = () => [{}];
    const click = vi.spyOn(button, 'click');
    expect(openLogin()).toEqual({ opened: true, evidence: 'clic_bouton_connexion' });
    expect(click).toHaveBeenCalledTimes(1);
  });

  it('ne clique jamais sur un lien de déconnexion', () => {
    document.body.innerHTML = '<a id="d" href="/deconnexion">Se déconnecter</a>';
    const link = document.getElementById('d');
    link.getClientRects = () => [{}];
    const click = vi.spyOn(link, 'click');
    expect(openLogin()).toEqual({ opened: false, evidence: null });
    expect(click).not.toHaveBeenCalled();
  });

  it('ignore un lien de connexion vers un autre site', () => {
    document.body.innerHTML = '<a href="https://exemple.test/connexion">Mon compte</a>';
    expect(openLogin()).toEqual({ opened: false, evidence: null });
  });
  const visible = (element) => {
    element.getClientRects = () => [{}];
    return vi.spyOn(element, 'click');
  };

  it('ne clique pas sur « Créer un compte ou se connecter » ni sur une connexion Google', () => {
    document.body.innerHTML =
      '<button id="a">Créer un compte ou se connecter</button><a id="g" href="/connexion-google">Connexion</a>';
    const clickA = visible(document.getElementById('a'));
    const clickG = visible(document.getElementById('g'));
    expect(openLogin()).toEqual({ opened: false, evidence: null });
    expect(clickA).not.toHaveBeenCalled();
    expect(clickG).not.toHaveBeenCalled();
  });

  it('ne clique jamais sur un bouton de formulaire déjà affiché', () => {
    document.body.innerHTML = '<form><button id="s" type="submit">Connexion</button></form>';
    const click = visible(document.getElementById('s'));
    expect(openLogin()).toEqual({ opened: false, evidence: null });
    expect(click).not.toHaveBeenCalled();
  });

  it('ignore un texte « Connexion » qui mène vers un autre site', () => {
    document.body.innerHTML = '<a id="x" href="https://exemple.test/auth">Connexion</a>';
    const click = visible(document.getElementById('x'));
    expect(openLogin()).toEqual({ opened: false, evidence: null });
    expect(click).not.toHaveBeenCalled();
  });

  it('refuse un lien de déconnexion encodé', () => {
    document.body.innerHTML = '<a href="/d%C3%A9connexion">Mon compte</a>';
    expect(openLogin()).toEqual({ opened: false, evidence: null });
  });

  it('suit un lien de connexion du même site, même caché dans un menu', () => {
    document.body.innerHTML = '<a href="/connexion?hasorigin=true">Mon compte</a>';
    const assign = vi.fn();
    const original = window.location;
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { href: original.href, origin: original.origin, assign }
    });
    try {
      expect(openLogin()).toEqual({ opened: true, evidence: 'lien_connexion' });
      expect(assign).toHaveBeenCalledWith(`${original.origin}/connexion?hasorigin=true`);
    } finally {
      Object.defineProperty(window, 'location', { configurable: true, value: original });
    }
  });
});
