import { useEffect, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';

export type ConnectionState = 'connecting' | 'live' | 'offline';

/**
 * One authenticated Socket.IO connection per page. `handlers` may change on
 * every render; the latest version is always used without reconnecting.
 */
export function useSocket(token: string | null, handlers: Record<string, (payload: any) => void>) {
  const [state, setState] = useState<ConnectionState>('connecting');
  const [socket, setSocket] = useState<Socket | null>(null);
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    if (!token) return;
    const s = io({ auth: { token }, transports: ['websocket'] });
    setSocket(s);
    s.on('connect', () => {
      setState('live');
      handlersRef.current.connect?.(undefined);
    });
    s.on('disconnect', () => setState('offline'));
    s.on('connect_error', () => setState('offline'));
    s.onAny((event, payload) => handlersRef.current[event]?.(payload));
    return () => {
      s.disconnect();
      setSocket(null);
    };
  }, [token]);

  return { socket, state };
}
