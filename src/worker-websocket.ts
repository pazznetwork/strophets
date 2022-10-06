import './websocket';
import { debug, error, log, LogLevel } from './log';
import { Connection } from './connection';
import { StropheWebsocket } from './websocket';
import { Status } from './status';
import { $build } from './builder-helper';
import { NS } from './namespace';
import { serialize } from './xml';

const lmap = {
  debug: LogLevel.DEBUG,
  info: LogLevel.INFO,
  warn: LogLevel.WARN,
  error: LogLevel.ERROR,
  fatal: LogLevel.FATAL
};

/** Class: Strophe.WorkerWebsocket
 *  _Private_ helper class that handles a websocket connection inside a shared worker.
 */
export class WorkerWebsocket extends StropheWebsocket {
  private worker: SharedWorker;
  private _messageHandler: (m: MessageEvent) => void;

  get socket(): WebSocket {
    return {
      send: (str: string) => this.worker.port.postMessage(['send', str])
    } as WebSocket;
  }

  /** PrivateConstructor: Strophe.WorkerWebsocket
   *  Create and initialize a Strophe.WorkerWebsocket object.
   *
   *  Parameters:
   *
   *    @param connection - The Strophe.Connection
   *
   *  Returns:
   *   @returns A new Strophe.WorkerWebsocket object.
   */
  constructor(connection: Connection) {
    super(connection);
    this.worker = new SharedWorker(this._conn.options.worker, 'Strophe XMPP Connection');
    this.worker.onerror = (e) => error(`Shared Worker Error: ${e}`);
  }

  _connect() {
    this._messageHandler = (m) => this._onInitialMessage(m);
    this.worker.port.start();
    this.worker.port.onmessage = (ev) => this._onWorkerMessage(ev);
    this.worker.port.postMessage(['_connect', this._conn.service, this._conn.jid]);
  }

  _attach(callback: () => void) {
    this._messageHandler = (m) => this._onMessage(m);
    this._conn.connect_callback = callback;
    this.worker.port.start();
    this.worker.port.onmessage = (ev) => this._onWorkerMessage(ev);
    this.worker.port.postMessage(['_attach', this._conn.service]);
  }

  _attachCallback(status: Status, jid: string) {
    if (status === Status.ATTACHED) {
      this._conn.jid = jid;
      this._conn.authenticated = true;
      this._conn.connected = true;
      this._conn.restored = true;
      this._conn._changeConnectStatus(Status.ATTACHED);
    } else if (status === Status.ATTACHFAIL) {
      this._conn.authenticated = false;
      this._conn.connected = false;
      this._conn.restored = false;
      this._conn._changeConnectStatus(Status.ATTACHFAIL);
    }
  }

  _disconnect(pres: Element) {
    pres && this._conn.send(pres);
    const close = $build('close', { xmlns: NS.FRAMING });
    this._conn.xmlOutput(close.tree());
    const closeString = serialize(close);
    this._conn.rawOutput(closeString);
    this.worker.port.postMessage(['send', closeString]);
    this._conn._doDisconnect();
  }

  _onClose(e: CloseEvent) {
    if (this._conn.connected && !this._conn.disconnecting) {
      error('Websocket closed unexpectedly');
      this._conn._doDisconnect();
    } else if (e && e.code === 1006 && !this._conn.connected) {
      // in case the onError callback was not called (Safari 10 does not
      // call onerror when the initial connection fails) we need to
      // dispatch a CONNFAIL status update to be consistent with the
      // behavior on other browsers.
      error('Websocket closed unexcectedly');
      this._conn._changeConnectStatus(Status.CONNFAIL, 'The WebSocket connection could not be established or was disconnected.');
      this._conn._doDisconnect();
    } else {
      debug('Websocket closed');
    }
  }

  _closeSocket() {
    this.worker.port.postMessage(['_closeSocket']);
  }

  /** PrivateFunction: _replaceMessageHandler
   *
   * Called by _onInitialMessage in order to replace itself with the general message handler.
   * This method is overridden by Strophe.WorkerWebsocket, which manages a
   * websocket connection via a service worker and doesn't have direct access
   * to the socket.
   */
  _replaceMessageHandler(): void {
    this._messageHandler = (m) => this._onMessage(m);
  }

  /** PrivateFunction: _onWorkerMessage
   * _Private_ function that handles messages received from the service worker
   */
  _onWorkerMessage(event: {
    data: [method_name: '_onMessage', message: MessageEvent] | [method_name: 'log', level: LogLevel, message: string];
  }): void {
    const { data } = event;
    const method_name = data[0];
    if (method_name === '_onMessage') {
      this._messageHandler(data[1]);
    } else if (method_name in this) {
      try {
        // @ts-ignore
        this[method_name].apply(this, event.data.slice(1));
      } catch (e) {
        log(LogLevel.ERROR, e);
      }
    } else if (method_name === 'log') {
      const level = data[1];
      const msg = data[2];
      log(lmap[level], msg);
    } else {
      log(LogLevel.ERROR, `Found unhandled service worker message: ${data}`);
    }
  }
}
