import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

function loadBridgeWithFirefoxRuntime(sendMessage, options = {}) {
  const messageListeners = [];
  const postedMessages = [];
  const elementsById = new Map();
  const window = {
    location: { origin: 'https://192.168.99.15:5174' },
    addEventListener(type, listener) {
      if (type === 'message') messageListeners.push(listener);
    },
    postMessage(message, targetOrigin) {
      postedMessages.push({ message, targetOrigin });
      for (const listener of messageListeners) {
        listener({ source: window, origin: window.location.origin, data: message });
      }
    }
  };
  const document = {
    readyState: 'complete',
    documentElement: {
      appendChild(element) {
        if (element.id) elementsById.set(element.id, element);
      }
    },
    querySelector(selector) {
      return selector === 'meta[name="drive-price-splitter-app"]' ? {} : null;
    },
    getElementById(id) {
      return elementsById.get(id) ?? null;
    },
    createElement() {
      let elementId = '';
      return {
        style: {},
        textContent: '',
        remove() {
          if (elementId) elementsById.delete(elementId);
        },
        get id() {
          return elementId;
        },
        set id(value) {
          if (elementId) elementsById.delete(elementId);
          elementId = value;
          if (value) elementsById.set(value, this);
        }
      };
    }
  };
  const browser = {
    storage: { local: { get: () => Promise.resolve(options.storageResult ?? { verboseDiagnostics: true }) } },
    runtime: {
      sendMessage,
      onMessage: { addListener() {} }
    }
  };

  vm.runInNewContext(readFileSync(new URL('./pwa-bridge.js', import.meta.url), 'utf8'), {
    browser,
    document,
    globalThis: { browser },
    window
  });

  return {
    postedMessages,
    window,
    getBadge: () => elementsById.get('drive-price-splitter-debug-badge') ?? null
  };
}

describe('pwa-bridge', () => {
  it('relaye la réponse du background quand Firefox expose sendMessage en Promise', async () => {
    const { postedMessages, window } = loadBridgeWithFirefoxRuntime((message) =>
      Promise.resolve({
        available: message.type === 'DRIVE_CONNECTOR_STATUS',
        protocolVersion: 1,
        extensionVersion: '0.5.test'
      })
    );

    window.postMessage(
      {
        source: 'drive-price-splitter-pwa',
        type: 'DRIVE_CONNECTOR_STATUS',
        nonce: 'nonce-bridge-123'
      },
      window.location.origin
    );
    await Promise.resolve();

    expect(postedMessages).toContainEqual({
      targetOrigin: window.location.origin,
      message: {
        source: 'drive-price-splitter-extension',
        type: 'DRIVE_CONNECTOR_STATUS_RESULT',
        nonce: 'nonce-bridge-123',
        response: { available: true, protocolVersion: 1, extensionVersion: '0.5.test' }
      }
    });
  });

  it('laisse le badge diagnostic masqué tant que le flag local est désactivé', async () => {
    const { getBadge } = loadBridgeWithFirefoxRuntime(
      () =>
        Promise.resolve({
          available: true,
          protocolVersion: 1,
          extensionVersion: '0.5.test'
        }),
      { storageResult: { verboseDiagnostics: false } }
    );

    await Promise.resolve();
    await Promise.resolve();

    expect(getBadge()).toBeNull();
  });

  it('affiche le badge diagnostic quand le flag local est activé', async () => {
    const { getBadge } = loadBridgeWithFirefoxRuntime(() =>
      Promise.resolve({
        available: true,
        protocolVersion: 1,
        extensionVersion: '0.5.test'
      })
    );

    await Promise.resolve();
    await Promise.resolve();

    expect(getBadge()?.textContent).toContain('DPS: OK v0.5.test');
  });
});
