import { Connection } from './connection';
import { Status } from './status';

export interface ProtocolManager {
  connection: Connection;

  /**
   *  Reset the connection.
   *
   *  This function is called by the reset function of the Strophe Connection.
   *  Is not needed by WebSockets.
   */
  reset(): void;

  /**
   * Connect to the server using the current protocol manager
   */
  connect(): void;

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
  noAuthReceived(): void;

  /**
   *  sends all queued stanzas
   */
  onIdle(): void;

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
