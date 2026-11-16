// Le protocole entre l'application et l'extension est écrit deux fois, à la
// main : ici (drive-protocol.js) et dans
// src/features/drive-bridge/driveProtocol.ts. Rien ne les reliait à part des
// commentaires : une limite modifiée d'un seul côté passait inaperçue, les
// messages étant alors refusés en silence par l'autre. Ce test échoue dès
// que les deux copies divergent sur les constantes ou sur ce qu'elles
// acceptent.
import { describe, expect, it } from 'vitest';
import * as extensionProtocol from './drive-protocol.js';
import * as appProtocol from '../../src/features/drive-bridge/driveProtocol';

const SHARED_CONSTANTS = ['DRIVE_PROTOCOL_VERSION', 'DRIVE_JOB_MAX_AGE_MS', 'DRIVE_MAX_PRODUCTS', 'DRIVE_MAX_STORES'];
const SHARED_VALIDATORS = ['validateDriveRefreshJob', 'validateDriveObservation'];

const accepts = (validator, value) => {
  try {
    validator(value);
    return true;
  } catch {
    return false;
  }
};

describe('parité du protocole application / extension', () => {
  it.each(SHARED_CONSTANTS)('%s a la même valeur des deux côtés', (name) => {
    expect(extensionProtocol[name]).toBeDefined();
    expect(extensionProtocol[name]).toBe(appProtocol[name]);
  });

  it.each(SHARED_VALIDATORS)('%s refuse les mêmes messages invalides des deux côtés', (name) => {
    const invalidMessages = [
      null,
      'texte',
      [],
      {},
      { protocolVersion: appProtocol.DRIVE_PROTOCOL_VERSION },
      { protocolVersion: appProtocol.DRIVE_PROTOCOL_VERSION + 1, products: [], stores: [] },
      { protocolVersion: appProtocol.DRIVE_PROTOCOL_VERSION, products: 'x', stores: 'y' }
    ];
    for (const message of invalidMessages) {
      expect(accepts(extensionProtocol[name], message)).toBe(false);
      expect(accepts(appProtocol[name], message)).toBe(false);
    }
  });
});
