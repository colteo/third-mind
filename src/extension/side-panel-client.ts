import { browser, type Browser } from 'wxt/browser';
import { SIDE_PANEL_PORT_NAME, parseHostMessage, type ClientMessage, type HostMessage } from './protocol';

export type ConnectionStatus = 'connecting' | 'connected' | 'reconnecting';

export interface HostConnectionHandlers {
  readonly onMessage: (message: HostMessage) => void;
  readonly onStatusChange: (status: ConnectionStatus) => void;
}

export interface HostConnection {
  send(message: ClientMessage): boolean;
  close(): void;
}

const RECONNECT_DELAY_MS = 500;

/**
 * Side-panel end of the port to the background service worker.
 *
 * When Chrome terminates the service worker the port disconnects. The client
 * reconnects, which wakes the worker; the worker then restores the session
 * from its checkpoint and sends a fresh snapshot.
 */
export function connectToHost(handlers: HostConnectionHandlers): HostConnection {
  let port: Browser.runtime.Port | null = null;
  let closed = false;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;

  const connect = (): void => {
    const next = browser.runtime.connect({ name: SIDE_PANEL_PORT_NAME });
    port = next;
    next.onMessage.addListener((raw: unknown) => {
      const message = parseHostMessage(raw);
      if (message !== null) {
        handlers.onMessage(message);
      }
    });
    next.onDisconnect.addListener(() => {
      port = null;
      if (closed) {
        return;
      }
      handlers.onStatusChange('reconnecting');
      retryTimer = setTimeout(connect, RECONNECT_DELAY_MS);
    });
    handlers.onStatusChange('connected');
  };

  handlers.onStatusChange('connecting');
  connect();

  return {
    send(message) {
      if (port === null) {
        return false;
      }
      try {
        port.postMessage(message);
        return true;
      } catch {
        return false;
      }
    },
    close() {
      closed = true;
      clearTimeout(retryTimer);
      port?.disconnect();
      port = null;
    },
  };
}
