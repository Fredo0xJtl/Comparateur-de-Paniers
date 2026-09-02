export type CopyResult = 'copied' | 'unavailable';

type ClipboardDependencies = {
  writeText?: (text: string) => Promise<void>;
  legacyCopy?: (text: string) => boolean;
};

export async function copyTextWithFallback(
  text: string,
  dependencies: ClipboardDependencies = {}
): Promise<CopyResult> {
  const writeText = dependencies.writeText ?? globalThis.navigator?.clipboard?.writeText;
  const legacyCopy = dependencies.legacyCopy ?? copyTextWithTextarea;

  if (writeText) {
    try {
      await writeText.call(globalThis.navigator?.clipboard, text);
      return 'copied';
    } catch {
      // Continue to the local fallback below.
    }
  }

  return legacyCopy(text) ? 'copied' : 'unavailable';
}

function copyTextWithTextarea(text: string) {
  if (typeof document === 'undefined') {
    return false;
  }

  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.left = '-9999px';
  textarea.style.top = '0';
  document.body.append(textarea);
  textarea.select();

  try {
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    textarea.remove();
  }
}
