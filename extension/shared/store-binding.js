const allowedHosts = {
  leclerc: new Set(['leclercdrive.fr']),
  hyperu: new Set(['www.coursesu.com', 'coursesu.com'])
};

export function rankStoreBindingCandidates(input, candidates) {
  return candidates
    .map((candidate) => {
      validateCandidate(input.storeKey, candidate);
      const score = calculateScore(input, candidate);
      return {
        ...candidate,
        score,
        confidence: score >= 75 ? 'high' : score >= 45 ? 'medium' : 'low'
      };
    })
    .sort((left, right) => right.score - left.score);
}

export function chooseStoreBindingCandidate(input, candidates) {
  const ranked = rankStoreBindingCandidates(input, candidates);
  const best = ranked[0];
  const second = ranked[1];
  if (!best || best.confidence !== 'high') return null;
  if (second && best.score - second.score < 15) return null;
  return best;
}

function calculateScore(input, candidate) {
  let score = 0;
  if (normalize(input.postalCode) && normalize(input.postalCode) === normalize(candidate.postalCode)) {
    score += 50;
  }
  if (normalize(input.city) && normalize(input.city) === normalize(candidate.city)) {
    score += 25;
  }

  score += Math.round(nameSimilarity(input.displayName, candidate.displayName) * 15);

  const distance = distanceKilometers(input, candidate);
  if (distance !== null) {
    if (distance <= 5) score += 20;
    else if (distance <= 20) score += 10;
  }
  return score;
}

function validateCandidate(storeKey, candidate) {
  if (
    !candidate ||
    typeof candidate.externalStoreId !== 'string' ||
    typeof candidate.displayName !== 'string' ||
    typeof candidate.catalogUrl !== 'string'
  ) {
    throw new Error('Candidat Drive invalide');
  }
  try {
    const url = new URL(candidate.catalogUrl);
    const allowed =
      storeKey === 'leclerc'
        ? url.hostname === 'leclercdrive.fr' || url.hostname.endsWith('.leclercdrive.fr')
        : storeKey === 'hyperu'
          ? url.hostname === 'coursesu.com' || url.hostname.endsWith('.coursesu.com')
          : allowedHosts[storeKey]?.has(url.hostname);
    if (url.protocol !== 'https:' || !allowed) {
      throw new Error('Candidat Drive invalide');
    }
  } catch {
    throw new Error('Candidat Drive invalide');
  }
}

function nameSimilarity(left, right) {
  const leftTokens = new Set(tokenize(left));
  const rightTokens = new Set(tokenize(right));
  if (leftTokens.size === 0 || rightTokens.size === 0) return 0;
  let common = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) common += 1;
  }
  return common / Math.max(leftTokens.size, rightTokens.size);
}

function tokenize(value) {
  return normalize(value)
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 1 && !['drive', 'leclerc', 'hyper', 'super'].includes(token));
}

function normalize(value) {
  return typeof value === 'string'
    ? value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase()
    : '';
}

function distanceKilometers(left, right) {
  if (
    !Number.isFinite(left.latitude) ||
    !Number.isFinite(left.longitude) ||
    !Number.isFinite(right.latitude) ||
    !Number.isFinite(right.longitude)
  ) {
    return null;
  }
  const earthRadiusKm = 6371;
  const latitudeDelta = toRadians(right.latitude - left.latitude);
  const longitudeDelta = toRadians(right.longitude - left.longitude);
  const a =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(toRadians(left.latitude)) *
      Math.cos(toRadians(right.latitude)) *
      Math.sin(longitudeDelta / 2) ** 2;
  return earthRadiusKm * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function toRadians(value) {
  return (value * Math.PI) / 180;
}
