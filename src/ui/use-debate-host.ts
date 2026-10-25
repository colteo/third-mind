import { useCallback, useEffect, useRef, useState } from 'react';
import type { ConnectionsView, LivePreflightResult } from '../application';
import type { ConversationProviderId } from '../domain';
import type { ClientMessage, HostSnapshot, PageCheckView } from '../extension/protocol';
import { connectToHost, type ConnectionStatus, type HostConnection } from '../extension/side-panel-client';

export interface DebateHost {
  readonly snapshot: HostSnapshot | null;
  /** Linked conversations; independent of the debate snapshot. */
  readonly connections: ConnectionsView | null;
  /** Latest page check per provider. Diagnostic only; not part of the link state. */
  readonly pageChecks: PageChecks;
  /** Latest live preflight result, from any panel. */
  readonly liveReadiness: LivePreflightResult | null;
  readonly connection: ConnectionStatus;
  readonly notice: string | null;
  readonly send: (message: ClientMessage) => void;
  readonly dismissNotice: () => void;
  /** Requests a live preflight. Unlike `send`, it leaves the current notice in place. */
  readonly checkLiveReadiness: () => void;
}

export type PageChecks = Partial<Record<ConversationProviderId, PageCheckView>>;

/** Connects the panel to the background host and exposes its latest snapshot. */
export function useDebateHost(): DebateHost {
  const [snapshot, setSnapshot] = useState<HostSnapshot | null>(null);
  const [connections, setConnections] = useState<ConnectionsView | null>(null);
  const [pageChecks, setPageChecks] = useState<PageChecks>({});
  const [liveReadiness, setLiveReadiness] = useState<LivePreflightResult | null>(null);
  const [connection, setConnection] = useState<ConnectionStatus>('connecting');
  const [notice, setNotice] = useState<string | null>(null);
  const connectionRef = useRef<HostConnection | null>(null);

  useEffect(() => {
    const hostConnection = connectToHost({
      onMessage: (message) => {
        switch (message.type) {
          case 'snapshot':
            setSnapshot(message.snapshot);
            break;
          case 'connections':
            setConnections(message.connections);
            break;
          case 'page-check': {
            const { check } = message;
            setPageChecks((previous) => {
              const next = { ...previous };
              next[check.provider] = check;
              return next;
            });
            break;
          }
          case 'live-readiness':
            setLiveReadiness(message.readiness);
            break;
          case 'command-rejected':
            setNotice(message.reason);
            break;
        }
      },
      onStatusChange: setConnection,
    });
    connectionRef.current = hostConnection;
    return () => {
      hostConnection.close();
      connectionRef.current = null;
    };
  }, []);

  const send = useCallback((message: ClientMessage) => {
    setNotice(null);
    if (connectionRef.current?.send(message) !== true) {
      setNotice('The background service is not connected yet. Please try again in a moment.');
    }
  }, []);

  const dismissNotice = useCallback(() => {
    setNotice(null);
  }, []);

  const checkLiveReadiness = useCallback(() => {
    connectionRef.current?.send({ type: 'check-live-readiness' });
  }, []);

  return { snapshot, connections, pageChecks, liveReadiness, connection, notice, send, dismissNotice, checkLiveReadiness };
}
