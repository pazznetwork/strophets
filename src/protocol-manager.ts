import { Connection } from './connection';
import { Status } from './status';

export interface ProtocolManager {
  connection: Connection;

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
   * Called on stream start/restart when no stream:features has been received.
   */
  noAuthReceived(): void;

  /**
   *  Send a stanza.
   *
   *  For BOSH:
   *  This function is called to push data onto the send queue to go out over the wire.  Whenever a request is sent to the BOSH
   *  server, all pending data is sent and the queue is flushed.
   *
   *  For Websocket:
   *  Sends the stanza immediately.
   *
   *  @param elem - The stanza to send.
   */
  send(elem: Element): void;
}
