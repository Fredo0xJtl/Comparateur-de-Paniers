import { deflateRawSync } from 'node:zlib';

// Écriture d'archives ZIP sans dépendance externe.
//
// POURQUOI PLUTÔT QU'UNE BIBLIOTHÈQUE OU UN OUTIL SYSTÈME
//
// Le paquet soumis à Mozilla est un .zip, et il n'existe aucun moyen fiable
// d'en produire un ici : Windows n'a pas la commande `zip`, et
// `Compress-Archive` (PowerShell) écrit les chemins internes avec des
// antislashs — une archive que plusieurs outils lisent de travers, pour un
// fichier dont dépend toute la publication. Ajouter une dépendance npm de
// compression pour ce seul usage reviendrait à faire entrer du code tiers
// dans la chaîne qui fabrique le paquet signé : exactement l'endroit où
// l'on ne veut pas en ajouter.
//
// Le format est donc écrit ici, en entier et volontairement minimal : une
// seule méthode de compression (deflate), pas de chiffrement, pas de zip64
// (sans objet pour un paquet de quelques centaines de kilo-octets), et les
// chemins toujours en séparateurs POSIX comme la spécification l'exige.

const LOCAL_FILE_HEADER = 0x04034b50;
const CENTRAL_DIRECTORY_HEADER = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const VERSION_NEEDED = 20; // 2.0 : deflate, le minimum pour ce que l'on écrit
const METHOD_DEFLATE = 8;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

export function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// Le format ZIP date de MS-DOS : la date tient sur deux entiers 16 bits, avec
// une résolution de deux secondes et une année comptée depuis 1980.
export function toDosDateTime(date) {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  };
}

/**
 * Construit une archive en mémoire.
 *
 * @param {{name: string, data: Buffer}[]} entries chemins internes en
 *   séparateurs POSIX, relatifs à la racine de l'archive.
 * @param {Date} [modifiedAt] date inscrite pour toutes les entrées. Fixée par
 *   l'appelant plutôt que prise sur l'horloge : deux constructions du même
 *   contenu donnent alors le même fichier, ce qui rend une archive
 *   vérifiable.
 */
export function createZip(entries, modifiedAt = new Date()) {
  const { time, date } = toDosDateTime(modifiedAt);
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name.replaceAll('\\', '/'), 'utf8');
    const compressed = deflateRawSync(entry.data, { level: 9 });
    const checksum = crc32(entry.data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_FILE_HEADER, 0);
    local.writeUInt16LE(VERSION_NEEDED, 4);
    // Bit 11 : les noms sont en UTF-8. Sans lui, un accent dans un chemin est
    // relu selon la page de codes du système qui ouvre l'archive.
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(METHOD_DEFLATE, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);

    chunks.push(local, name, compressed);

    const header = Buffer.alloc(46);
    header.writeUInt32LE(CENTRAL_DIRECTORY_HEADER, 0);
    header.writeUInt16LE(VERSION_NEEDED, 4);
    header.writeUInt16LE(VERSION_NEEDED, 6);
    header.writeUInt16LE(0x0800, 8);
    header.writeUInt16LE(METHOD_DEFLATE, 10);
    header.writeUInt16LE(time, 12);
    header.writeUInt16LE(date, 14);
    header.writeUInt32LE(checksum, 16);
    header.writeUInt32LE(compressed.length, 20);
    header.writeUInt32LE(entry.data.length, 24);
    header.writeUInt16LE(name.length, 28);
    header.writeUInt16LE(0, 30);
    header.writeUInt16LE(0, 32);
    header.writeUInt16LE(0, 34);
    header.writeUInt16LE(0, 36);
    header.writeUInt32LE(0, 38);
    header.writeUInt32LE(offset, 42);
    central.push(header, name);

    offset += local.length + name.length + compressed.length;
  }

  const centralBuffer = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(END_OF_CENTRAL_DIRECTORY, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...chunks, centralBuffer, end]);
}
