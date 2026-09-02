const STOP_WORDS = new Set([
  'avenue', 'boulevard', 'centre', 'cedex', 'drive', 'leclerc', 'magasin', 'route', 'rue'
]);

export function rankLeclercDriveChoices(store, choices) {
  const unique = new Map();
  for (const choice of choices) {
    if (!Number.isInteger(choice?.actionIndex) || typeof choice?.text !== 'string') continue;
    const normalized = normalize(choice.text);
    if (!normalized || unique.has(normalized)) continue;
    unique.set(normalized, { ...choice, normalized });
  }

  const expectedTokens = tokens(`${store.displayName ?? ''} ${store.address ?? ''}`);
  return [...unique.values()]
    .map((choice) => {
      const choiceTokens = tokens(choice.text);
      let score = 0;
      if (store.postalCode && choice.normalized.includes(normalize(store.postalCode))) score += 50;
      if (store.city && choice.normalized.includes(normalize(store.city))) score += 25;
      for (const token of expectedTokens) if (choiceTokens.has(token)) score += 4;
      if (/choisir|selectionner|commencer/.test(choice.normalized)) score += 5;
      return { ...choice, score };
    })
    .sort((left, right) => right.score - left.score || left.text.length - right.text.length);
}

export function chooseLeclercDriveChoice(store, choices) {
  const ranked = rankLeclercDriveChoices(store, choices);
  const best = ranked[0];
  const second = ranked[1];
  if (!best || best.score < 13) return { choice: null, ranked, code: 'DRIVE_RESULT_NOT_FOUND' };
  if (second && best.score === second.score) {
    return { choice: null, ranked, code: 'DRIVE_RESULT_AMBIGUOUS' };
  }
  return { choice: best, ranked, code: null };
}

function tokens(value) {
  return new Set(
    normalize(value)
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length > 2 && !STOP_WORDS.has(token))
  );
}

function normalize(value) {
  return String(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase();
}
