import { Connection } from './connection';
import { $build } from './builder-helper';
import { NS } from './namespace';
import { Status } from './status';
import { debug, error, warn } from './log';
import { serialize } from './xml';
import { ErrorCondition } from './error';
import { ProtocolManager } from './protocol-manager';
import { Subject } from 'rxjs';
import { Builder } from './builder';

/**
 *  The StropheWebSocket class is used internally by the Connection class to handle protocol changes on demand
 */
export class StropheWebsocket implements ProtocolManager {
  readonly connection: Connection;
  protected socket: WebSocket;

  /**
   *   @param connection - The Connection owning this protocol manager
   *   @param stanzasInSubject - will be called for incoming messages
   */
  constructor(connection: Connection, private readonly stanzasInSubject: Subject<Element>) {
    this.connection = connection;

    const service = connection.service;
    if (service.indexOf('ws:') !== 0 && service.indexOf('wss:') !== 0) {
      // If the service is not an absolute URL, assume it is a path and put the absolute
      // URL together from options, current URL and the path.
      let newService = '';
      if (connection.options.protocol === 'ws' && window.location.protocol !== 'https:') {
        newService += 'ws';
      } else {
        newService += 'wss';
      }

      newService += '://' + window.location.host;
      if (service.indexOf('/') !== 0) {
        newService += window.location.pathname + service;
      } else {
        newService += service;
      }
      connection.service = newService;
    }
  }

  /**
   *  Generates the <stream> start tag for WebSocket stream
   *
   *  @returns A Strophe.Builder containing a <stream> element.
   */
  buildStream(): Builder {
    return $build('open', {
      xmlns: NS.FRAMING,
      to: this.connection.domain,
      version: '1.0',
    });
  }

  /**
   *   checks a message for stream:error
   *
   *    @param bodyWrap - The received stanza.
   *    @param status - The ConnectStatus that will be set on error.
   */
  checkStreamError(bodyWrap: Element, status: Status): boolean {
    const errors = bodyWrap.getElementsByTagNameNS(NS.STREAM, 'error');

    if (errors.length === 0) {
      return false;
    }

    const receivedError = errors[0];
    const ns = 'urn:ietf:params:xml:ns:xmpp-streams';
    const errorNodes: Element[] = Array.from(receivedError.childNodes) as Element[];
    const errorNode = errorNodes.find((node) => node.getAttribute('xmlns') !== ns);
    const isTextNode = errorNode.nodeName !== 'text';
    const condition = isTextNode ? errorNode.nodeName : 'unknown';

    error(`WebSocket stream error: ${condition} - ${isTextNode ? errorNode.textContent : ''}`);

    // close the connection on streamError
    this.connection.changeConnectStatus(status, condition);
    this.connection.doDisconnect();
    return true;
  }

  /**
   *  Reset the connection.
   *
   *  This function is called by the reset function of the Strophe Connection.
   *  Is not needed by WebSockets.
   */
  reset(): void {
    return;
  }

  /**
   *  Creates a WebSocket for a connection and assigns Callbacks to it.
   *  Does nothing if there already is a WebSocket.
   */
  connect(): void {
    // Ensure that there is no open WebSocket from a previous Connection.
    this.closeSocket();
    this.socket = new WebSocket(this.connection.service, 'xmpp');
    this.socket.onopen = () => this.onOpen();
    this.socket.onerror = (e) => this.onError(e);
    this.socket.onclose = (e) => this.onClose(e);
    // Gets replaced with this._onMessage once _onInitialMessage is called
    this.socket.onmessage = (message) => this.onInitialMessage(message);
  }

  /** PrivateFunction: _connect_cb
   *  _Private_ function called by Strophe.Connection._connect_cb
   *
   * checks for stream:error
   *
   *  Parameters:
   *    (Strophe.Request) bodyWrap - The received stanza.
   */
  connectCb(bodyWrap: Element): Status {
    const stropheError = this.checkStreamError(bodyWrap, Status.CONNFAIL);
    if (stropheError) {
      return Status.CONNFAIL;
    }
    return Status.CONNECTED;
  }

  /**
   * function that checks the opening <open /> tag for errors.
   *
   * Disconnects if there is an error and returns false, true otherwise.
   *
   * @param message - Stanza containing the <open /> tag.
   */
  handleStreamStartStanza(message: Element): boolean {
    let errorMessage;

    // Check for errorMessages in the <open /> tag
    const ns = message.getAttribute('xmlns');
    if (ns == null) {
      errorMessage = 'Missing xmlns in <open />';
    } else if (ns !== NS.FRAMING) {
      errorMessage = 'Wrong xmlns in <open />: ' + ns;
    }

    const ver = message.getAttribute('version');
    if (ver == null) {
      errorMessage = 'Missing version in <open />';
    } else if (ver !== '1.0') {
      errorMessage = 'Wrong version in <open />: ' + ver;
    }

    if (errorMessage) {
      this.connection.changeConnectStatus(Status.CONNFAIL, errorMessage);
      this.connection.doDisconnect();
      return false;
    }
    return true;
  }

  /**
   * On receiving an opening stream tag this callback replaces itself with the real
   * message handler. On receiving a stream error the connection is terminated.
   */
  onInitialMessage(message: { data: string }): void {
    if (message.data.indexOf('<open ') === 0 || message.data.indexOf('<?xml') === 0) {
      // Strip the XML Declaration, if there is one
      const data = message.data.replace(/^(<\?.*?\?>\s*)*/, '');
      if (data === '') {
        return;
      }

      const streamStart = this.parseToXml(data);
      this.connection.xmlInput(streamStart);
      this.stanzasInSubject.next(streamStart);

      //_handleStreamSteart will check for XML errors and disconnect on error
      if (this.handleStreamStartStanza(streamStart)) {
        //_connect_cb will check for stream:error and disconnect on error
        this.connectCb(streamStart);
      }
    } else if (message.data.indexOf('<close ') === 0) {
      // <close xmlns="urn:ietf:params:xml:ns:xmpp-framing />
      // Parse the raw string to an XML element
      const parsedMessage = this.parseToXml(message.data);
      // Report this input to the raw and xml handlers
      this.connection.xmlInput(parsedMessage);
      this.stanzasInSubject.next(parsedMessage);
      const see_uri = parsedMessage.getAttribute('see-other-uri');
      if (see_uri) {
        const service = this.connection.service;
        // Valid scenarios: WSS->WSS, WS->ANY
        const isSecureRedirectOld =
          (service.indexOf('wss:') >= 0 && see_uri.indexOf('wss:') >= 0) ||
          service.indexOf('ws:') >= 0;
        const isSecureRedirect =
          (service.includes('wss:') && see_uri.includes('wss:')) || service.includes('ws:');
        if (isSecureRedirectOld !== isSecureRedirect) {
          throw new Error('BAD REFACTOR!!!!');
        }
        if (isSecureRedirect) {
          this.connection.changeConnectStatus(
            Status.REDIRECT,
            'Received see-other-uri, resetting connection'
          );
          this.connection.reset();
          this.connection.service = see_uri;
          this.connect();
        }
      } else {
        this.connection.changeConnectStatus(Status.CONNFAIL, 'Received closing stream');
        this.connection.doDisconnect();
      }
    } else {
      // replace the message handler set to onInitialMessage with the general message handler
      this.socket.onmessage = (m) => this.onMessage(m);
      const wrappedXML = this.streamWrap(message.data);
      const elem = this.parseToXml(wrappedXML);
      this.connection.connectCallback(elem);
    }
  }

  /**
   *  Disconnects and sends a last stanza if one is given
   *
   *  @param pres - This stanza will be sent before disconnecting.
   */
  disconnect(pres?: Element): void {
    if (this.socket && this.socket.readyState !== WebSocket.CLOSED) {
      if (pres) {
        this.connection.send(pres);
      }
      const close = $build('close', { xmlns: NS.FRAMING });
      this.connection.xmlOutput(close.tree());
      const closeString = serialize(close);
      try {
        this.socket.send(closeString);
      } catch (e) {
        warn("Couldn't send <close /> tag.");
      }
    }
    setTimeout(() => this.connection.doDisconnect(), 0);
  }

  /**
   *  Just closes the Socket for WebSockets
   */
  doDisconnect(): void {
    debug('WebSockets doDisconnect was called');
    this.closeSocket();
  }

  /**
   * Wraps a stanza in a <ws-stream> tag. This is used we can process stanzas from WebSockets like BOSH in Connection
   */
  streamWrap(stanza: string): string {
    return '<ws-wrapper>' + stanza + '</ws-wrapper>';
  }

  /**
   *  Closes the socket if it is still open and deletes it
   */
  closeSocket(): void {
    if (!this.socket) {
      return;
    }
    try {
      this.socket.onclose = null;
      this.socket.onerror = null;
      this.socket.onmessage = null;
      this.socket.close();
    } catch (e) {
      debug(e.message);
    }
    this.socket = null;
  }

  /**
   *   @returns true, because WebSocket messages are send immediately after queueing.
   */
  emptyQueue(): true {
    return true;
  }

  /**
   * Handles the websockets closing.
   */
  onClose(e: CloseEvent): void {
    if (this.connection.connected && !this.connection.disconnecting) {
      error('Websocket closed unexpectedly');
      this.connection.doDisconnect();
    } else if (e && e.code === 1006 && !this.connection.connected && this.socket) {
      // in case the onError callback was not called (Safari 10 does not
      // call onerror when the initial connection fails) we need to
      // dispatch a CONNFAIL status update to be consistent with the
      // behavior on other browsers.
      error('Websocket closed unexcectedly');
      this.connection.changeConnectStatus(
        Status.CONNFAIL,
        'The WebSocket connection could not be established or was disconnected.'
      );
      this.connection.doDisconnect();
    } else {
      debug('Websocket closed');
    }
  }

  /**
   * Called on stream start/restart when no stream:features has been received.
   */
  noAuthReceived(): void {
    error('Server did not offer a supported authentication mechanism');
    this.connection.changeConnectStatus(Status.CONNFAIL, ErrorCondition.NO_AUTH_MECH);
    this.connection.doDisconnect();
  }

  /**
   * @param webSocketError - The websocket error.
   */
  onError(webSocketError: Event): void {
    error('Websocket error ' + JSON.stringify(webSocketError));
    this.connection.changeConnectStatus(
      Status.CONNFAIL,
      'The WebSocket connection could not be established or was disconnected.'
    );
    this.disconnect();
  }

  /**
   *  sends all queued stanzas
   */
  onIdle(): void {
    const data = this.connection.data;
    if (data.length > 0 && !this.connection.paused) {
      for (const dataPart of data) {
        if (dataPart !== null) {
          const stanza = dataPart.tagName === 'restart' ? this.buildStream().tree() : dataPart;
          const rawStanza = serialize(stanza);
          this.connection.xmlOutput(stanza);
          this.socket.send(rawStanza);
        }
      }
      this.connection.data = [];
    }
  }

  /**
   * This function handles the websocket messages and parses each of the messages as if they are full documents.
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
   * @param message - The websocket message.
   */
  onMessage({ data: xmlData }: MessageEvent): void {
    let elem;
    // check for closing stream
    const close = '<close xmlns="urn:ietf:params:xml:ns:xmpp-framing" />';
    if (xmlData === close) {
      this.connection.xmlInput(xmlData);
      this.stanzasInSubject.next(xmlData);
      if (!this.connection.disconnecting) {
        this.connection.doDisconnect();
      }
      return;
    } else if (xmlData.search('<open ') === 0) {
      // This handles stream restarts
      elem = this.parseToXml(xmlData);
      if (!this.handleStreamStartStanza(elem)) {
        return;
      }
    } else {
      const data = this.streamWrap(xmlData);
      elem = this.parseToXml(data);
    }

    if (this.checkStreamError(elem, Status.ERROR)) {
      return;
    }

    const firstChild = elem.firstChild as Element;
    //handle unavailable presence stanza before disconnecting
    if (
      this.connection.disconnecting &&
      firstChild.nodeName === 'presence' &&
      firstChild.getAttribute('type') === 'unavailable'
    ) {
      this.connection.xmlInput(elem);
      this.stanzasInSubject.next(elem);
      // if we are already disconnecting we will ignore the unavailable stanza and
      // wait for the </stream:stream> tag before we close the connection
      return;
    }
    this.connection.dataReceived(elem);
  }

  /**
   * Handles websockets connection setup and sends the opening stream tag.
   */
  onOpen(): void {
    debug('Websocket open');
    const start = this.buildStream();
    this.connection.xmlOutput(start.tree());
    this.stanzasInSubject.next(start.tree());

    const startString = serialize(start);
    this.socket.send(startString);
  }

  /**
   * Flushes the messages that are in the queue
   */
  send(): void {
    this.connection.flush();
  }

  /**
   *  Send an xmpp:restart stanza.
   */
  sendRestart(): void {
    clearTimeout(this.connection.idleTimeout);
    this.connection.onIdle.bind(this.connection)();
  }

  private parseToXml(data: string): Element {
    return new DOMParser().parseFromString(data, 'text/xml').documentElement;
  }
}
