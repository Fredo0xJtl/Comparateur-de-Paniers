import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { assertPackageable } from './package-firefox-extension.mjs';
import { createZip, crc32, toDosDateTime } from './zip-writer.mjs';

const productionManifest = {
  version: '0.7.0',
  content_scripts: [{ matches: ['https://fredo0xjtl.github.io/Comparateur-de-Paniers/*'] }],
  browser_specific_settings: { gecko: { id: 'comparateur-de-paniers@fredo0xjtl.github.io' } }
};
const productionEntries = [
  { name: 'manifest.json', data: Buffer.from('{}') },
  { name: 'background/service-worker.js', data: Buffer.from('') }
];

// Ces contrôles sont la dernière barrière avant un téléversement sur AMO :
// chaque cas ci-dessous correspond à une erreur qui ne se voit qu'une fois le
// paquet refusé, ou publié.
describe('assertPackageable', () => {
  it('laisse passer un build de production complet', () => {
    expect(assertPackageable(productionManifest, productionEntries)).toEqual([]);
  });

  it('refuse une archive sans manifest.json à la racine', () => {
    // Mozilla cherche manifest.json à la racine : archiver le dossier au lieu
    // de son contenu produit un paquet systématiquement rejeté.
    const problems = assertPackageable(productionManifest, [
      { name: 'extension-firefox/manifest.json', data: Buffer.from('{}') }
    ]);
    expect(problems.join(' ')).toMatch(/manifest\.json absent/);
  });

  it('refuse un build --dev', () => {
    // Les origines locales du poste de développement donneraient, chez un
    // utilisateur, le droit d'injecter le pont depuis n'importe quelle page
    // portant ces mêmes adresses sur son propre réseau.
    const problems = assertPackageable(
      {
        ...productionManifest,
        content_scripts: [{ matches: ['https://fredo0xjtl.github.io/Comparateur-de-Paniers/*', 'http://localhost/*'] }]
      },
      productionEntries
    );
    expect(problems.join(' ')).toMatch(/origines de développement/);
  });

  it('refuse un identifiant de test', () => {
    const problems = assertPackageable(
      {
        ...productionManifest,
        browser_specific_settings: { gecko: { id: 'drive-price-splitter-localtest@fredo0xjtl.github.io' } }
      },
      productionEntries
    );
    expect(problems.join(' ')).toMatch(/identifiant de test/);
  });

  it('refuse un paquet sans identifiant gecko', () => {
    const problems = assertPackageable({ ...productionManifest, browser_specific_settings: {} }, productionEntries);
    expect(problems.join(' ')).toMatch(/gecko\.id absent/);
  });

  it('refuse un port dans un match pattern', () => {
    const problems = assertPackageable(
      { ...productionManifest, content_scripts: [{ matches: ['https://exemple.fr:8443/*'] }] },
      productionEntries
    );
    expect(problems.join(' ')).toMatch(/port interdit/);
  });

  it('refuse des fichiers de test embarqués', () => {
    const problems = assertPackageable(productionManifest, [
      ...productionEntries,
      { name: 'shared/custom-origins.test.js', data: Buffer.from('') }
    ]);
    expect(problems.join(' ')).toMatch(/fichiers de test/);
  });
});

// Le format ZIP est écrit à la main (voir l'entête de zip-writer.mjs) : sa
// conformité ne peut pas être supposée, elle doit être constatée par un
// lecteur indépendant — d'où Python et son module `zipfile`, plutôt qu'une
// relecture par le code qui vient d'écrire l'archive, qui ne prouverait rien.
// Python n'est pas une dépendance du projet : là où il manque, ces cas sont
// ignorés plutôt que de faire échouer la CI sur un outil absent. Les
// contrôles de `assertPackageable`, eux, tournent partout.
const pythonCommand = (() => {
  for (const candidate of ['python', 'python3']) {
    try {
      execFileSync(candidate, ['--version'], { stdio: 'ignore' });
      return candidate;
    } catch {
      // Candidat suivant.
    }
  }
  return null;
})();

describe.skipIf(!pythonCommand)('createZip', () => {
  const workDir = mkdtempSync(join(tmpdir(), 'zip-writer-'));
  afterAll(() => rmSync(workDir, { recursive: true, force: true }));

  function readBackWithPython(archivePath) {
    const script = [
      'import json, sys, zipfile',
      'z = zipfile.ZipFile(sys.argv[1])',
      'corrompu = z.testzip()',
      'print(json.dumps({',
      '  "corrompu": corrompu,',
      '  "noms": sorted(z.namelist()),',
      '  "contenus": {n: z.read(n).decode("utf8") for n in z.namelist()}',
      '}))'
    ].join('\n');
    const scriptPath = join(workDir, 'relire.py');
    writeFileSync(scriptPath, script);
    return JSON.parse(execFileSync(pythonCommand, [scriptPath, archivePath], { encoding: 'utf8' }));
  }

  it('produit une archive qu’un lecteur ZIP indépendant relit à l’identique', () => {
    const entries = [
      { name: 'manifest.json', data: Buffer.from('{"name":"Comparateur de Paniers"}', 'utf8') },
      // Contenu répétitif : vérifie que la compression deflate est bien
      // appliquée et relue, pas seulement du stockage brut.
      { name: 'shared/origines.js', data: Buffer.from('export const A = 1;\n'.repeat(200), 'utf8') },
      // Accent dans le contenu : le drapeau UTF-8 doit être posé.
      { name: 'options/aide.txt', data: Buffer.from('Où l’extension est active', 'utf8') }
    ];
    const archivePath = join(workDir, 'paquet.zip');
    writeFileSync(archivePath, createZip(entries, new Date('2026-01-01T12:00:00Z')));

    const relu = readBackWithPython(archivePath);
    expect(relu.corrompu).toBeNull();
    expect(relu.noms).toEqual(['manifest.json', 'options/aide.txt', 'shared/origines.js']);
    for (const entry of entries) {
      expect(relu.contenus[entry.name]).toBe(entry.data.toString('utf8'));
    }
  });

  it('convertit les séparateurs Windows en séparateurs POSIX', () => {
    // Un chemin en antislashs donne une archive que plusieurs outils lisent
    // comme un seul fichier au nom bizarre, jamais comme une arborescence.
    const archivePath = join(workDir, 'chemins.zip');
    writeFileSync(
      archivePath,
      createZip([{ name: 'shared\\custom-origins.js', data: Buffer.from('export const A = 1;') }])
    );
    expect(readBackWithPython(archivePath).noms).toEqual(['shared/custom-origins.js']);
  });

  it('donne le même fichier pour le même contenu à la même date', () => {
    // Reproductibilité : une archive dont l'empreinte change à chaque
    // construction ne peut pas être vérifiée après coup.
    const entries = [{ name: 'manifest.json', data: Buffer.from('{}') }];
    const date = new Date('2026-01-01T12:00:00Z');
    expect(createZip(entries, date).equals(createZip(entries, date))).toBe(true);
  });

  it('produit une archive vide lisible', () => {
    const archivePath = join(workDir, 'vide.zip');
    writeFileSync(archivePath, createZip([]));
    expect(readBackWithPython(archivePath).noms).toEqual([]);
  });
});

describe('primitives du format ZIP', () => {
  it('calcule le CRC-32 attendu', () => {
    // Vecteur de référence du standard : CRC-32 de « 123456789 ».
    expect(crc32(Buffer.from('123456789', 'utf8'))).toBe(0xcbf43926);
    expect(crc32(Buffer.alloc(0))).toBe(0);
  });

  it('encode la date au format MS-DOS', () => {
    // Résolution de deux secondes, année comptée depuis 1980.
    const { date, time } = toDosDateTime(new Date(2026, 8, 8, 14, 30, 20));
    expect((date >> 9) + 1980).toBe(2026);
    expect((date >> 5) & 0b1111).toBe(9);
    expect(date & 0b11111).toBe(8);
    expect(time >> 11).toBe(14);
    expect((time >> 5) & 0b111111).toBe(30);
    expect((time & 0b11111) * 2).toBe(20);
  });

  it('ramène une date antérieure à 1980 dans le domaine du format', () => {
    expect((toDosDateTime(new Date(1970, 0, 1)).date >> 9) + 1980).toBe(1980);
  });
});

// Contrôle de bout en bout sur le paquet réellement destiné à Mozilla, quand
// il a déjà été construit : c'est ce fichier-là qui part, pas une archive de
// test.
describe('paquet réellement produit', () => {
  const buildManifestPath = new URL('../dist/extension-firefox/manifest.json', import.meta.url);

  it('le build présent, s’il existe, est packageable', () => {
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(buildManifestPath, 'utf8'));
    } catch {
      // Clone frais ou build de développement supprimé : rien à vérifier.
      return;
    }
    if (manifest.name?.includes('(dev')) return;
    expect(assertPackageable(manifest, [{ name: 'manifest.json', data: Buffer.from('{}') }])).toEqual([]);
  });
});
