import { type UserStore } from '../../types/domain';

export function buildLeclercSearchUrl(query: string, userStore?: UserStore) {
  const baseUrl = normalizeBaseUrl(userStore?.driveUrl, 'https://www.leclercdrive.fr/');
  return `${baseUrl}search?q=${encodeURIComponent(query)}`;
}

export function buildHyperUSearchUrl(query: string, userStore?: UserStore) {
  const baseUrl = normalizeBaseUrl(userStore?.driveUrl, 'https://www.coursesu.com/');
  return `${baseUrl}recherche?text=${encodeURIComponent(query)}`;
}

function normalizeBaseUrl(value: string | undefined, fallback: string) {
  const baseUrl = value?.trim() || fallback;
  return baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
}
