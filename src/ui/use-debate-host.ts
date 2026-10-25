import { useCallback, useEffect, useRef, useState } from 'react';
import type { ConnectionsView } from '../application';
import type { ClientMessage, HostSnapshot } from '../extension/protocol';
import { connectToHost, type ConnectionStatus, type HostConnection } from '../extension/side-panel-client';

export interface DebateHost {
  readonly snapshot: HostSnapshot | null;
  /** Linked conversations; independent of the debate snapshot. */
  readonly connections: ConnectionsView | null;
  readonly connection: ConnectionStatus;
  readonly notice: string | null;
  readonly send: (message: ClientMessage) => void;
  readonly dismissNotice: () => void;
}

/** Connects the panel to the background host and exposes its latest snapshot. */
export function useDebateHost(): DebateHost {
  const [snapshot, setSnapshot] = useState<HostSnapshot | null>(null);
  const [connections, setConnections] = useState<ConnectionsView | null>(null);
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

  return { snapshot, connections, connection, notice, send, dismissNotice };
}
