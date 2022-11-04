import { Connection } from './connection';
import { Status } from './status';
import { Request } from './request';

export interface ProtocolManager {
  connection: Connection;
  strip: string;

  /**
   *  Reset the connection.
   *
   *  This function is called by the reset function of the Strophe Connection.
   *  Is not needed by WebSockets.
   */
  reset(): void;

  /**
   *
   * @param wait - The optional HTTPBIND wait value.  This is the
   *      time the server will wait before returning an empty result for
   *      a request.  The default setting of 60 seconds is recommended.
   * @param hold - The optional HTTPBIND hold value.  This is the
   *      number of connections the server will hold at one time.  This
   *      should almost always be set to 1 (the default).
   * @param route - The optional route value.
   */
  connect(wait?: number, hold?: number, route?: string): void;

  /**
   *
   * checks for stream:error
   *
   *  Parameters:
   *    (Strophe.Request) bodyWrap - The received stanza.
   */
  connectCb(bodyWrap: Element): Status;

  /**
   *  Disconnects and sends a last stanza if one is given
   *
   *  Parameters:
   *    (Request) pres - This stanza will be sent before disconnecting.
   */
  disconnect(pres?: Element): void;

  /**
   *  Just closes the Socket for WebSockets
   */
  doDisconnect(): void;

  /**
   *  Returns:
   *    True, because WebSocket messages are send immediately after queueing.
   */
  emptyQueue(): boolean;

  /**
   * Called on stream start/restart when no stream:features has been received.
   */
  noAuthReceived(callback: () => void): void;

  /**
   * Timeout handler for handling non-graceful disconnection. This does nothing for WebSockets
   */
  onDisconnectTimeout(): void;

  /**
   * makes sure all pending requests are aborted.
   */
  abortAllRequests(): void;

  /**
   *  sends all queued stanzas
   */
  onIdle(): void;

  /**
   *
   * Get a stanza out of a request. WebSockets don't use requests, so the passed argument is just returned.
   *
   *  Parameters:
   *    (Object) stanza - The stanza.
   *
   *  Returns:
   *    The stanza that was passed.
   */
  reqToData(request: Request): Element;

  /**
   *  Part of the Connection.send function for WebSocket
   *
   * Just flushes the messages that are in the queue
   */
  send(): void;

  /**
   *  Send an xmpp:restart stanza.
   */
  sendRestart(): void;
}
