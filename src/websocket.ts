import { Connection } from './connection';
import { $build } from './builder-helper';
import { NS } from './namespace';
import { Status } from './status';
import { debug, error, warn } from './log';
import { serialize } from './xml';
import { ErrorCondition } from './error';

/**
 /**
 *  _Private_ helper class that handles WebSocket Connections
 *
 *  The Strophe.WebSocket class is used internally by Strophe.Connection
 *  to encapsulate WebSocket sessions. It is not meant to be used from user's code.
 */
export class StropheWebsocket {
  protected readonly _conn: Connection;
  private strip: string;

  private _socket: WebSocket;
  protected get socket(): WebSocket {
    return this._socket;
  }
  protected set socket(value: WebSocket) {
    this._socket = value;
  }

  /** PrivateConstructor: Strophe.Websocket
   *  Create and initialize a Strophe.WebSocket object.
   *  Currently only sets the connection Object.
   *
   *  Parameters:
   *    (Strophe.Connection) connection - The Strophe.Connection that will use WebSockets.
   *
   *  Returns:
   *    A new Strophe.WebSocket object.
   */
  constructor(connection: Connection) {
    this._conn = connection;
    this.strip = 'wrapper';

    const service = connection.service;
    if (service.indexOf('ws:') !== 0 && service.indexOf('wss:') !== 0) {
      // If the service is not an absolute URL, assume it is a path and put the absolute
      // URL together from options, current URL and the path.
      let new_service = '';
      if (connection.options.protocol === 'ws' && window.location.protocol !== 'https:') {
        new_service += 'ws';
      } else {
        new_service += 'wss';
      }

      new_service += '://' + window.location.host;
      if (service.indexOf('/') !== 0) {
        new_service += window.location.pathname + service;
      } else {
        new_service += service;
      }
      connection.service = new_service;
    }
  }

  /** PrivateFunction: _buildStream
   *  _Private_ helper function to generate the <stream> start tag for WebSockets
   *
   *  Returns:
   *    A Strophe.Builder with a <stream> element.
   */
  _buildStream() {
    return $build('open', {
      xmlns: NS.FRAMING,
      to: this._conn.domain,
      version: '1.0'
    });
  }

  /** PrivateFunction: _checkStreamError
   * _Private_ checks a message for stream:error
   *
   *  Parameters:
   *    (Strophe.Request) bodyWrap - The received stanza.
   *    status - The ConnectStatus that will be set on error.
   *  Returns:
   *     true if there was a streamerror, false otherwise.
   */
  _checkStreamError(bodyWrap: Element, status: Status) {
    let errors;
    if (bodyWrap.getElementsByTagNameNS) {
      errors = bodyWrap.getElementsByTagNameNS(NS.STREAM, 'error');
    } else {
      errors = bodyWrap.getElementsByTagName('stream:error');
    }
    if (errors.length === 0) {
      return false;
    }

    const receivedError = errors[0];

    let condition = '';
    let text = '';

    const ns = 'urn:ietf:params:xml:ns:xmpp-streams';
    for (const errorNode of Array.from(receivedError.childNodes)) {
      if ((errorNode as Element).getAttribute('xmlns') !== ns) {
        break;
      }
      if (errorNode.nodeName === 'text') {
        text = errorNode.textContent;
      } else {
        condition = errorNode.nodeName;
      }
    }

    let errorString = 'WebSocket stream error: ';
    if (condition) {
      errorString += condition;
    } else {
      errorString += 'unknown';
    }
    if (text) {
      errorString += ' - ' + text;
    }
    error(errorString);

    // close the connection on stream_error
    this._conn._changeConnectStatus(status, condition);
    this._conn._doDisconnect();
    return true;
  }

  /** PrivateFunction: _reset
   *  Reset the connection.
   *
   *  This function is called by the reset function of the Strophe Connection.
   *  Is not needed by WebSockets.
   */
  _reset() {
    return;
  }

  /** PrivateFunction: _connect
   *  _Private_ function called by Strophe.Connection.connect
   *
   *  Creates a WebSocket for a connection and assigns Callbacks to it.
   *  Does nothing if there already is a WebSocket.
   */
  _connect() {
    // Ensure that there is no open WebSocket from a previous Connection.
    this._closeSocket();
    this.socket = new WebSocket(this._conn.service, 'xmpp');
    this.socket.onopen = () => this._onOpen();
    this.socket.onerror = (e) => this._onError(e);
    this.socket.onclose = (e) => this._onClose(e);
    // Gets replaced with this._onMessage once _onInitialMessage is called
    this.socket.onmessage = (message) => this._onInitialMessage(message);
  }

  /** PrivateFunction: _connect_cb
   *  _Private_ function called by Strophe.Connection._connect_cb
   *
   * checks for stream:error
   *
   *  Parameters:
   *    (Strophe.Request) bodyWrap - The received stanza.
   */
  _connect_cb(bodyWrap: Element): Status {
    const stropheError = this._checkStreamError(bodyWrap, Status.CONNFAIL);
    if (stropheError) {
      return Status.CONNFAIL;
    }
    return Status.CONNECTED;
  }

  /** PrivateFunction: _handleStreamStart
   * _Private_ function that checks the opening <open /> tag for errors.
   *
   * Disconnects if there is an error and returns false, true otherwise.
   *
   *  Parameters:
   *    (Node) message - Stanza containing the <open /> tag.
   */
  _handleStreamStart(message: Element) {
    let errorMessage;

    // Check for errorMessages in the <open /> tag
    const ns = message.getAttribute('xmlns');
    if (typeof ns !== 'string') {
      errorMessage = 'Missing xmlns in <open />';
    } else if (ns !== NS.FRAMING) {
      errorMessage = 'Wrong xmlns in <open />: ' + ns;
    }

    const ver = message.getAttribute('version');
    if (typeof ver !== 'string') {
      errorMessage = 'Missing version in <open />';
    } else if (ver !== '1.0') {
      errorMessage = 'Wrong version in <open />: ' + ver;
    }

    if (errorMessage) {
      this._conn._changeConnectStatus(Status.CONNFAIL, errorMessage);
      this._conn._doDisconnect();
      return false;
    }
    return true;
  }

  /** PrivateFunction: _onInitialMessage
   * _Private_ function that handles the first connection messages.
   *
   * On receiving an opening stream tag this callback replaces itself with the real
   * message handler. On receiving a stream error the connection is terminated.
   */
  _onInitialMessage(message: { data: string }) {
    if (message.data.indexOf('<open ') === 0 || message.data.indexOf('<?xml') === 0) {
      // Strip the XML Declaration, if there is one
      const data = message.data.replace(/^(<\?.*?\?>\s*)*/, '');
      if (data === '') {
        return;
      }

      const streamStart = new DOMParser().parseFromString(data, 'text/xml').documentElement;
      this._conn.xmlInput(streamStart);
      this._conn.rawInput(message.data);

      //_handleStreamSteart will check for XML errors and disconnect on error
      if (this._handleStreamStart(streamStart)) {
        //_connect_cb will check for stream:error and disconnect on error
        this._connect_cb(streamStart);
      }
    } else if (message.data.indexOf('<close ') === 0) {
      // <close xmlns="urn:ietf:params:xml:ns:xmpp-framing />
      // Parse the raw string to an XML element
      const parsedMessage = new DOMParser().parseFromString(message.data, 'text/xml').documentElement;
      // Report this input to the raw and xml handlers
      this._conn.xmlInput(parsedMessage);
      this._conn.rawInput(message.data);
      const see_uri = parsedMessage.getAttribute('see-other-uri');
      if (see_uri) {
        const service = this._conn.service;
        // Valid scenarios: WSS->WSS, WS->ANY
        const isSecureRedirect = (service.indexOf('wss:') >= 0 && see_uri.indexOf('wss:') >= 0) || service.indexOf('ws:') >= 0;
        if (isSecureRedirect) {
          this._conn._changeConnectStatus(Status.REDIRECT, 'Received see-other-uri, resetting connection');
          this._conn.reset();
          this._conn.service = see_uri;
          this._connect();
        }
      } else {
        this._conn._changeConnectStatus(Status.CONNFAIL, 'Received closing stream');
        this._conn._doDisconnect();
      }
    } else {
      this._replaceMessageHandler();
      const string = this._streamWrap(message.data);
      const elem = new DOMParser().parseFromString(string, 'text/xml').documentElement;
      this._conn._connect_cb(elem, null, message.data);
    }
  }

  /** PrivateFunction: _replaceMessageHandler
   *
   * Called by _onInitialMessage in order to replace itself with the general message handler.
   * This method is overridden by Strophe.WorkerWebsocket, which manages a
   * websocket connection via a service worker and doesn't have direct access
   * to the socket.
   */
  _replaceMessageHandler() {
    this.socket.onmessage = (m) => this._onMessage(m);
  }

  /** PrivateFunction: _disconnect
   *  _Private_ function called by Strophe.Connection.disconnect
   *
   *  Disconnects and sends a last stanza if one is given
   *
   *  Parameters:
   *    (Request) pres - This stanza will be sent before disconnecting.
   */
  _disconnect(pres?: Element) {
    if (this.socket && this.socket.readyState !== WebSocket.CLOSED) {
      if (pres) {
        this._conn.send(pres);
      }
      const close = $build('close', { xmlns: NS.FRAMING });
      this._conn.xmlOutput(close.tree());
      const closeString = serialize(close);
      this._conn.rawOutput(closeString);
      try {
        this.socket.send(closeString);
      } catch (e) {
        warn("Couldn't send <close /> tag.");
      }
    }
    setTimeout(() => this._conn._doDisconnect(), 0);
  }

  /** PrivateFunction: _doDisconnect
   *  _Private_ function to disconnect.
   *
   *  Just closes the Socket for WebSockets
   */
  _doDisconnect() {
    debug('WebSockets _doDisconnect was called');
    this._closeSocket();
  }

  /** PrivateFunction _streamWrap
   *  _Private_ helper function to wrap a stanza in a <stream> tag.
   *  This is used so Strophe can process stanzas from WebSockets like BOSH
   */
  _streamWrap(stanza: string) {
    return '<wrapper>' + stanza + '</wrapper>';
  }

  /** PrivateFunction: _closeSocket
   *  _Private_ function to close the WebSocket.
   *
   *  Closes the socket if it is still open and deletes it
   */
  _closeSocket() {
    if (this.socket) {
      try {
        this.socket.onclose = null;
        this.socket.onerror = null;
        this.socket.onmessage = null;
        this.socket.close();
      } catch (e) {
        debug(e.message);
      }
    }
    this.socket = null;
  }

  /** PrivateFunction: _emptyQueue
   * _Private_ function to check if the message queue is empty.
   *
   *  Returns:
   *    True, because WebSocket messages are send immediately after queueing.
   */
  _emptyQueue() {
    return true;
  }

  /** PrivateFunction: _onClose
   * _Private_ function to handle websockets closing.
   */
  _onClose(e: CloseEvent) {
    if (this._conn.connected && !this._conn.disconnecting) {
      error('Websocket closed unexpectedly');
      this._conn._doDisconnect();
    } else if (e && e.code === 1006 && !this._conn.connected && this.socket) {
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

  /** PrivateFunction: _no_auth_received
   *
   * Called on stream start/restart when no stream:features
   * has been received.
   */
  _no_auth_received(callback: () => void) {
    error('Server did not offer a supported authentication mechanism');
    this._conn._changeConnectStatus(Status.CONNFAIL, ErrorCondition.NO_AUTH_MECH);
    if (callback) {
      callback.call(this._conn);
    }
    this._conn._doDisconnect();
  }

  /** PrivateFunction: _onDisconnectTimeout
   *  _Private_ timeout handler for handling non-graceful disconnection.
   *
   *  This does nothing for WebSockets
   */
  _onDisconnectTimeout() {}

  /** PrivateFunction: _abortAllRequests
   *  _Private_ helper function that makes sure all pending requests are aborted.
   */
  _abortAllRequests() {}

  /** PrivateFunction: _onError
   * _Private_ function to handle websockets errors.
   *
   * Parameters:
   * (Object) error - The websocket error.
   */
  _onError(webSocketError: Event) {
    error('Websocket error ' + JSON.stringify(webSocketError));
    this._conn._changeConnectStatus(Status.CONNFAIL, 'The WebSocket connection could not be established or was disconnected.');
    this._disconnect();
  }

  /** PrivateFunction: _onIdle
   *  _Private_ function called by Strophe.Connection._onIdle
   *
   *  sends all queued stanzas
   */
  _onIdle() {
    const data = this._conn._data;
    if (data.length > 0 && !this._conn.paused) {
      for (const dataPart of data) {
        if (dataPart !== null) {
          const stanza = dataPart.tagName === 'restart' ? this._buildStream().tree() : dataPart;
          const rawStanza = serialize(stanza);
          this._conn.xmlOutput(stanza);
          this._conn.rawOutput(rawStanza);
          this.socket.send(rawStanza);
        }
      }
      this._conn._data = [];
    }
  }

  /** PrivateFunction: _onMessage
   * _Private_ function to handle websockets messages.
   *
   * This function parses each of the messages as if they are full documents.
   * [TODO : We may actually want to use a SAX Push parser].
   *
   * Since all XMPP traffic starts with
   *  <stream:stream version='1.0'
   *                 xml:lang='en'
   *                 xmlns='jabber:client'
   *                 xmlns:stream='http://etherx.jabber.org/streams'
   *                 id='3697395463'
   *                 from='SERVER'>
   *
   * The first stanza will always fail to be parsed.
   *
   * Additionally, the seconds stanza will always be <stream:features> with
   * the stream NS defined in the previous stanza, so we need to 'force'
   * the inclusion of the NS in this stanza.
   *
   * Parameters:
   * (string) message - The websocket message.
   */
  _onMessage(message: MessageEvent) {
    let elem;
    // check for closing stream
    const close = '<close xmlns="urn:ietf:params:xml:ns:xmpp-framing" />';
    if (message.data === close) {
      this._conn.rawInput(close);
      this._conn.xmlInput(message);
      if (!this._conn.disconnecting) {
        this._conn._doDisconnect();
      }
      return;
    } else if (message.data.search('<open ') === 0) {
      // This handles stream restarts
      elem = new DOMParser().parseFromString(message.data, 'text/xml').documentElement;
      if (!this._handleStreamStart(elem)) {
        return;
      }
    } else {
      const data = this._streamWrap(message.data);
      elem = new DOMParser().parseFromString(data, 'text/xml').documentElement;
    }

    if (this._checkStreamError(elem, Status.ERROR)) {
      return;
    }

    const firstChild = elem.firstChild as Element;
    //handle unavailable presence stanza before disconnecting
    if (this._conn.disconnecting && firstChild.nodeName === 'presence' && firstChild.getAttribute('type') === 'unavailable') {
      this._conn.xmlInput(elem);
      this._conn.rawInput(serialize(elem));
      // if we are already disconnecting we will ignore the unavailable stanza and
      // wait for the </stream:stream> tag before we close the connection
      return;
    }
    this._conn._dataRecv(elem, message.data);
  }

  /** PrivateFunction: _onOpen
   * _Private_ function to handle websockets connection setup.
   *
   * The opening stream tag is sent here.
   */
  _onOpen() {
    debug('Websocket open');
    const start = this._buildStream();
    this._conn.xmlOutput(start.tree());

    const startString = serialize(start);
    this._conn.rawOutput(startString);
    this.socket.send(startString);
  }

  /** PrivateFunction: _reqToData
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
  _reqToData(stanza: Element) {
    return stanza;
  }

  /** PrivateFunction: _send
   *  _Private_ part of the Connection.send function for WebSocket
   *
   * Just flushes the messages that are in the queue
   */
  _send() {
    this._conn.flush();
  }

  /** PrivateFunction: _sendRestart
   *
   *  Send an xmpp:restart stanza.
   */
  _sendRestart() {
    clearTimeout(this._conn._idleTimeout);
    this._conn._onIdle.bind(this._conn)();
  }
}
