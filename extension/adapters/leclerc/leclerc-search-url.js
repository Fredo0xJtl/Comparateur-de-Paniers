export function buildLeclercSearchUrl(currentUrl, query) {
  let url;
  try {
    url = new URL(currentUrl);
  } catch {
    return null;
  }
  if (
    url.protocol !== 'https:' ||
    !/^fd\d+-courses\.leclercdrive\.fr$/i.test(url.hostname)
  ) {
    return null;
  }

  const storeMatch = url.pathname.match(
    /^(\/magasin-[^/]+?)(?:\.aspx|\/(?:home|recherche)\.aspx)$/i
  );
  if (!storeMatch) return null;
  const searchUrl = new URL(`${storeMatch[1]}/recherche.aspx`, url.origin);
  searchUrl.searchParams.set('TexteRecherche', String(query).trim().slice(0, 300));
  return searchUrl.href;
}
