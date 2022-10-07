// @ts-ignore
let manager;

enum Status {
  ERROR = 0,
  CONNECTING = 1,
  CONNFAIL = 2,
  AUTHENTICATING = 3,
  AUTHFAIL = 4,
  CONNECTED = 5,
  DISCONNECTED = 6,
  DISCONNECTING = 7,
  ATTACHED = 8,
  REDIRECT = 9,
  CONNTIMEOUT = 10,
  BINDREQUIRED = 11,
  ATTACHFAIL = 12
}

/** Class: ConnectionManager
 *
 * Manages the shared websocket connection as well as the ports of the
 * connected tabs.
 */
export class ConnectionManager {
  ports: MessagePort[];
  jid: any;
  socket: any;

  constructor() {
    this.ports = [];
  }

  addPort(port: MessagePort) {
    this.ports.push(port);
    port.addEventListener('message', (e) => {
      const method = e.data[0];
      try {
        this[method](e.data.splice(1));
      } catch (err) {
        // eslint-disable-next-line no-console
        console?.error(err);
      }
    });
    port.start();
  }

  _connect(data: [jid: string, url: string]) {
    this.jid = data[1];
    this._closeSocket();
    this.socket = new WebSocket(data[0], 'xmpp');
    this.socket.onopen = () => this._onOpen();
    this.socket.onerror = (e: CloseEvent) => this._onError(e);
    this.socket.onclose = (e: CloseEvent) => this._onClose(e);
    this.socket.onmessage = (message: MessageEvent) => this._onMessage(message);
  }

  _attach() {
    if (this.socket && this.socket.readyState !== WebSocket.CLOSED) {
      this.ports.forEach((p) => p.postMessage(['_attachCallback', Status.ATTACHED, this.jid]));
    } else {
      this.ports.forEach((p) => p.postMessage(['_attachCallback', Status.ATTACHFAIL]));
    }
  }

  send(str: string) {
    this.socket.send(str);
  }

  close(str: string) {
    if (this.socket && this.socket.readyState !== WebSocket.CLOSED) {
      try {
        this.socket.send(str);
      } catch (e) {
        this.ports.forEach((p) => p.postMessage(['log', 'error', e]));
        this.ports.forEach((p) => p.postMessage(['log', 'error', "Couldn't send <close /> tag."]));
      }
    }
  }

  _onOpen() {
    this.ports.forEach((p) => p.postMessage(['_onOpen']));
  }

  _onClose(e: CloseEvent) {
    this.ports.forEach((p) => p.postMessage(['_onClose', e.reason]));
  }

  _onMessage(message: MessageEvent) {
    const o = { data: message.data };
    this.ports.forEach((p) => p.postMessage(['_onMessage', o]));
  }

  _onError(error: CloseEvent) {
    this.ports.forEach((p) => p.postMessage(['_onError', error.reason]));
  }

  _closeSocket() {
    if (this.socket) {
      try {
        this.socket.onclose = null;
        this.socket.onerror = null;
        this.socket.onmessage = null;
        this.socket.close();
      } catch (e) {
        this.ports.forEach((p) => p.postMessage(['log', 'error', e]));
      }
    }
    this.socket = null;
  }
}

// @ts-ignore
onconnect = function (e: { ports: MessagePort[] }) {
  // @ts-ignore
  manager = manager || new ConnectionManager();
  manager.addPort(e.ports[0]);
};
