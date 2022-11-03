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
   * called by Strophe.Connection.connect
   *
   * @param wait - The optional HTTPBIND wait value.  This is the
   *      time the server will wait before returning an empty result for
   *      a request.  The default setting of 60 seconds is recommended.
   * @param hold - The optional HTTPBIND hold value.  This is the
   *      number of connections the server will hold at one time.  This
   *      should almost always be set to 1 (the default).
   * @param route - The optional route value.
   */
  _connect(wait?: number, hold?: number, route?: string): void;

  /**
   *  _Private_ function called by Strophe.Connection._connect_cb
   *
   * checks for stream:error
   *
   *  Parameters:
   *    (Strophe.Request) bodyWrap - The received stanza.
   */
  _connect_cb(bodyWrap: Element): Status;

  /**
   *  _Private_ function called by Strophe.Connection.disconnect
   *
   *  Disconnects and sends a last stanza if one is given
   *
   *  Parameters:
   *    (Request) pres - This stanza will be sent before disconnecting.
   */
  _disconnect(pres?: Element): void;

  /**
   *  _Private_ function to disconnect.
   *
   *  Just closes the Socket for WebSockets
   */
  doDisconnect(): void;

  /**
   * _Private_ function to check if the message queue is empty.
   *
   *  Returns:
   *    True, because WebSocket messages are send immediately after queueing.
   */
  _emptyQueue(): boolean;

  /**
   *
   * Called on stream start/restart when no stream:features
   * has been received.
   */
  _no_auth_received(callback: () => void): void;

  /**
   *  _Private_ timeout handler for handling non-graceful disconnection.
   *
   *  This does nothing for WebSockets
   */
  _onDisconnectTimeout(): void;

  /**
   *  _Private_ helper function that makes sure all pending requests are aborted.
   */
  _abortAllRequests(): void;

  /**
   *  _Private_ function called by Strophe.Connection._onIdle
   *
   *  sends all queued stanzas
   */
  _onIdle(): void;

  /**
   * _Private_ function to get a stanza out of a request.
   *
   * WebSockets don't use requests, so the passed argument is just returned.
   *
   *  Parameters:
   *    (Object) stanza - The stanza.
   *
   *  Returns:
   *    The stanza that was passed.
   */
  _reqToData(request: Request): Element;

  /**
   *  _Private_ part of the Connection.send function for WebSocket
   *
   * Just flushes the messages that are in the queue
   */
  _send(): void;

  /**
   *
   *  Send an xmpp:restart stanza.
   */
  _sendRestart(): void;
}
