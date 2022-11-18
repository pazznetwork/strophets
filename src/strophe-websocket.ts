import { Connection } from './connection';
import { $build } from './builder-helper';
import { NS } from './namespace';
import { Status } from './status';
import { debug, error, warn } from './log';
import { serialize } from './xml';
import { ErrorCondition } from './error';
import { ProtocolManager } from './protocol-manager';
import { Subject, switchMap } from 'rxjs';
import { Builder } from './builder';

/**
 *  The StropheWebSocket class is used internally by the Connection class to handle protocol changes on demand
 */
export class StropheWebsocket implements ProtocolManager {
  readonly connection: Connection;
  readonly socket: WebSocket;

  private onWebsocketMessageSubject = new Subject<MessageEvent>();

  private initialMessage = true;

  /**
   *   @param connection - The Connection owning this protocol manager
   *   @param stanzasInSubject - will be called for incoming messages
   */
  constructor(connection: Connection, private readonly stanzasInSubject: Subject<Element>) {
    this.connection = connection;
    this.connection.service = this.determineWebsocketUrl(
      this.connection.service,
      this.connection?.options?.protocol
    );

    this.socket = new WebSocket(this.connection.service, 'xmpp');

    this.onWebsocketMessageSubject
      .pipe(switchMap((messageEvent: MessageEvent) => this.onMessage(messageEvent)))
      .subscribe();
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
   *  Creates a WebSocket for a connection and assigns Callbacks to it.
   *  Does nothing if there already is a WebSocket.
   */
  connect(): void {
    this.socket.onopen = () => this.onOpen();
    this.socket.onerror = (e) => this.onError(e);
    this.socket.onclose = () => this.onClose();
    this.initialMessage = true;
    this.socket.onmessage = (message) => this.onWebsocketMessageSubject.next(message);
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
   * On receiving an opening stream tag this callback replaces itself with the real
   * message handler. On receiving a stream error the connection is terminated.
   */
  async onInitialMessage(xmlData: string): Promise<void> {
    const isXmlDeclaration = xmlData.startsWith('<?xml');
    const isOpenStanza = xmlData.startsWith('<open');
    const isCloseStanza = xmlData.startsWith('<close');
    if (isXmlDeclaration) {
      return; /*
      // Strip the XML Declaration, if there is one
      const data = xmlData.replace(/^(<\?.*?\?>\s*)*!/, '');
      if (data === '') {
        return;
      }*/
    }

    if (!isOpenStanza && !isCloseStanza) {
      this.initialMessage = false;
      const elem = this.parseToXml(xmlData);
      await this.connection.connectCallbackWebsocket(this, elem);
      return;
    }

    if (isOpenStanza) {
      const streamStart = this.parseToXml(xmlData);
      this.connection.xmlInput?.(streamStart);
      this.stanzasInSubject.next(streamStart);

      //connectCb will check for stream:error and disconnect on error
      this.connectCb(streamStart);
      return;
    }

    if (isCloseStanza) {
      // <close xmlns="urn:ietf:params:xml:ns:xmpp-framing />
      // Parse the raw string to an XML element
      const parsedMessage = this.parseToXml(xmlData);
      // Report this input to the raw and xml handlers
      this.connection.xmlInput?.(parsedMessage);
      this.stanzasInSubject.next(parsedMessage);
      const seeUri = parsedMessage.getAttribute('see-other-uri');
      if (!seeUri) {
        this.connection.changeConnectStatus(Status.CONNFAIL, 'Received closing stream');
        this.connection.doDisconnect();
        return;
      }
      const service = this.connection.service;
      // Valid scenarios: WSS->WSS, WS->ANY
      const isSecureRedirect =
        (service.startsWith('wss:') && seeUri.startsWith('wss:')) || service.startsWith('ws:');
      if (!isSecureRedirect) {
        return;
      }
      this.connection.changeConnectStatus(
        Status.REDIRECT,
        'Received see-other-uri, resetting connection'
      );
      this.connection.reset();
      this.connection.service = seeUri;
      this.connect();
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
      this.connection.xmlOutput?.(close.tree());
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
   *  Removes listeners on the Websocket
   */
  doDisconnect(): void {
    error('WebSockets doDisconnect was called');
    try {
      this.socket.onclose = null;
      this.socket.onerror = null;
      this.socket.onmessage = null;
    } catch (e) {
      debug(e.message);
    }
  }

  /**
   * Handles the websockets closing.
   */
  onClose(): void {
    if (this.connection.connected && !this.connection.disconnecting) {
      error('Websocket closed unexpectedly');
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
  async onMessage({ data: xmlData }: MessageEvent): Promise<void> {
    if (this.initialMessage) {
      return this.onInitialMessage(xmlData);
    }

    const isCloseStanza = xmlData.startsWith(
      '<close xmlns="urn:ietf:params:xml:ns:xmpp-framing />'
    );
    if (isCloseStanza) {
      this.connection.xmlInput?.(xmlData);
      this.stanzasInSubject.next(xmlData);
      if (this.connection.disconnecting) {
        return;
      }
      this.connection.doDisconnect();
      return;
    }

    const elem = this.parseToXml(xmlData);

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
      this.connection.xmlInput?.(elem);
      this.stanzasInSubject.next(elem);
      // if we are already disconnecting we will ignore the unavailable stanza and
      // wait for the </stream:stream> tag before we close the connection
      return;
    }
    await this.connection.dataReceivedWebsocket(elem);
  }

  /**
   * Handles websockets connection setup and sends the opening stream tag.
   */
  onOpen(): void {
    debug('Websocket open');
    const start = this.buildStream();
    this.connection.xmlOutput?.(start.tree());
    this.stanzasInSubject.next(start.tree());

    const startString = serialize(start);
    this.socket.send(startString);
  }

  /**
   * Flushes the messages that are in the queue
   */
  send(elem: Element): void {
    this.connection.flush();
    const stanza = elem.tagName === 'restart' ? this.buildStream().tree() : elem;
    const rawStanza = serialize(stanza);
    this.connection.xmlOutput?.(stanza);
    this.socket.send(rawStanza);
  }

  private parseToXml(data: string): Element {
    return new DOMParser().parseFromString(data, 'text/xml').documentElement;
  }

  private determineWebsocketUrl(service: string, protocolOption: string | undefined): string {
    if (service.startsWith('ws:') || service.startsWith('wss:')) {
      return service;
    }

    // If the service is not an absolute URL, assume it is a path and put the absolute
    // URL together from options, current URL and the path.
    const prefix = protocolOption !== 'ws' || window.isSecureContext ? 'wss' : 'ws';
    const path = service.startsWith('/') ? service : window.location.pathname + service;

    return `${prefix}://${window.location.host}${path}`;
  }
}
