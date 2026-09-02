import { describe, it, expect } from 'vitest';
import { classifyLeclercPage } from './leclerc-probe.js';

describe('classifyLeclercPage', () => {
  it('reconnaît la page d’erreur technique Leclerc via le pathname (pgeWCSDxxx_Erreur.aspx)', () => {
    const result = classifyLeclercPage({
      hostname: 'fd7-courses.leclercdrive.fr',
      hasCaptcha: false,
      hasSiteError: true,
      hasStorePrompt: false,
      hasCatalog: false
    });
    expect(result).toEqual({ state: 'blocked', code: 'LECLERC_SITE_ERROR' });
  });

  it('un captcha reste prioritaire sur la détection de page d’erreur', () => {
    const result = classifyLeclercPage({
      hostname: 'fd7-courses.leclercdrive.fr',
      hasCaptcha: true,
      hasSiteError: true,
      hasStorePrompt: false,
      hasCatalog: false
    });
    expect(result).toEqual({ state: 'blocked', code: 'CAPTCHA_REQUIRED' });
  });

  it('un mauvais hostname reste prioritaire sur tout le reste', () => {
    const result = classifyLeclercPage({
      hostname: 'example.com',
      hasCaptcha: false,
      hasSiteError: true,
      hasStorePrompt: false,
      hasCatalog: false
    });
    expect(result).toEqual({ state: 'wrong_host', code: 'UNEXPECTED_HOST' });
  });

  it('un catalogue prêt sans page d’erreur reste inchangé', () => {
    const result = classifyLeclercPage({
      hostname: 'fd7-courses.leclercdrive.fr',
      hasCaptcha: false,
      hasSiteError: false,
      hasStorePrompt: false,
      hasCatalog: true
    });
    expect(result).toEqual({ state: 'catalog_ready', code: null });
  });

  it('une sélection de magasin requise sans page d’erreur reste inchangée', () => {
    const result = classifyLeclercPage({
      hostname: 'fd7-courses.leclercdrive.fr',
      hasCaptcha: false,
      hasSiteError: false,
      hasStorePrompt: true,
      hasCatalog: false
    });
    expect(result).toEqual({ state: 'store_required', code: 'DRIVE_SELECTION_REQUIRED' });
  });

  it('aucun signal reconnu retombe sur unknown/UNSUPPORTED_PAGE', () => {
    const result = classifyLeclercPage({
      hostname: 'fd7-courses.leclercdrive.fr',
      hasCaptcha: false,
      hasSiteError: false,
      hasStorePrompt: false,
      hasCatalog: false
    });
    expect(result).toEqual({ state: 'unknown', code: 'UNSUPPORTED_PAGE' });
  });
});
