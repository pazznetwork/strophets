import { SASLMechanism } from './sasl-mechanism';
import { TimedHandler } from './timed-handler';
import { Status } from './status';
import { Builder } from './builder';
import { addCookies } from './utils';
import { NS } from './namespace';
import {
  getBareJidFromJid,
  getDomainFromJid,
  getNodeFromJid,
  getResourceFromJid,
  getText,
} from './xml';
import { ErrorCondition } from './error';
import { $iq, $pres } from './builder-helper';
import { debug, info, log, LogLevel, warn } from './log';
import { Bosh } from './bosh';
import { StropheWebsocket } from './strophe-websocket';
import { ProtocolManager } from './protocol-manager';
import {
  debounceTime,
  filter,
  firstValueFrom,
  from as fromRxjs,
  merge,
  Observable,
  ReplaySubject,
  share,
  shareReplay,
  startWith,
  Subject,
} from 'rxjs';
import { Matcher, MatcherConfig } from './matcher';
import { ConnectionOptions } from './connection-options';
import { AuthenticationMode } from './authentication-mode';
import { Credentials } from './credentials';
import { Sasl } from './sasl';
import { HandlerService } from './handler-service';
import { register } from './extensions/register';
import { BoshRequest } from './bosh-request';
import { map } from 'rxjs/operators';

/**
 *  XMPP Connection manager.
 *
 *  This class is the main part of Strophe.  It manages a BOSH connection
 *  to an XMPP server and dispatches events to the user callbacks as
 *  data arrives.  It supports SASL PLAIN, SASL DIGEST-MD5, SASL SCRAM-SHA1
 *  and legacy authentication.
 *
 *  After creating a Strophe.Connection object, the user will typically
 *  call connect() with a user supplied callback to handle connection level
 *  events like authentication failure, disconnection, or connection
 *  complete.
 *
 *  The user will also have several event handlers defined by using
 *  addHandler() and addTimedHandler().  These will allow the user code to
 *  respond to interesting stanzas or do something periodically with the
 *  connection.  These handlers will be active once authentication is
 *  finished.
 *
 *  To send data to the connection, use send().
 */
export class Connection {
  private static instance: Connection;

  private readonly userJidSubject = new Subject<string>();
  readonly userJid$: Observable<string> = this.userJidSubject.pipe(share());

  private readonly willReconnectSubject = new Subject<void>();
  readonly willReconnect$: Observable<void> = this.willReconnectSubject.pipe(share());

  private readonly stanzasInSubject = new Subject<Element>();
  readonly stanzasIn$ = this.stanzasInSubject.pipe(share());

  private readonly stanzasOutSubject = new Subject<Element>();
  readonly stanzasOut$ = this.stanzasOutSubject.pipe(share());

  private readonly onBeforeOnlineSubject = new ReplaySubject<string>(1);
  readonly onBeforeOnline$ = this.onBeforeOnlineSubject.pipe(share());

  /**
   * Synchronous event triggered after we've sent an IQ to bind the user's JID resource for this session.
   */
  private readonly afterResourceBindingSubject = new Subject<void>();
  readonly afterResourceBinding$ = this.afterResourceBindingSubject.pipe(share());

  private readonly onOnlineSubject = new ReplaySubject<void>(1);
  readonly onOnline$ = this.onOnlineSubject.pipe(share());

  /**
   * Triggered after we disconnected from the XMPP server.
   */
  private readonly onOfflineSubject = new ReplaySubject<void>(1);
  readonly onOffline$ = this.onOfflineSubject.pipe(share());

  readonly isOnline$ = merge(
    this.onOnline$.pipe(map(() => true)),
    this.onOffline$.pipe(map(() => false))
  ).pipe(
    shareReplay({
      bufferSize: 1,
      refCount: true,
    })
  );

  readonly isOffline$ = this.isOnline$.pipe(map((online) => !online));

  private readonly connectionStatusSubject = new Subject<{
    status: Status;
    reason?: string;
    elem?: Element;
  }>();
  readonly connectionStatus$ = this.connectionStatusSubject.pipe(
    startWith({ status: Status.DISCONNECTED, reason: 'fresh instance' }),
    shareReplay({ bufferSize: 1, refCount: true })
  );

  /**
   * The domain of the connected JID.
   */
  domain: string = null;
  features: Element;

  authenticated: boolean;
  connected: boolean;
  disconnecting: boolean;

  maxRetries: number;

  status: Status;

  disconnectionTimeout: number;

  /**
   * protocol used for connection
   */
  protocolManager: ProtocolManager;

  idleTimeout: ReturnType<typeof setTimeout>;
  private disconnectTimeout: TimedHandler;

  readonly sasl = new Sasl(this);

  readonly handlerService = new HandlerService(this);

  /**
   *  User overrideable function that receives XML data coming into the
   *  connection.
   *
   *    @param elem - XML data received by the connection.
   */
  xmlInput: (elem: Element) => void;

  /**
   *  User overrideable function that receives XML data sent to the
   *  connection.
   *
   *    @param elem - XML data sent by the connection.
   */
  xmlOutput: (elem: Element) => void;

  /**
   * The connected JID.
   */
  private backingJid = '';

  /**
   * Stores the passed in JID for the current user, potentially creating a
   * resource if the JID is bare.
   */
  set jid(value: string) {
    this.backingJid = value;
    this.userJidSubject.next(this.backingJid);
  }

  get jid(): string {
    return this.backingJid;
  }

  /**
   *  Create and initialize a Strophe.Connection object.
   *
   *  The transport-protocol for this connection will be chosen automatically
   *  based on the given service parameter. URLs starting with "ws://" or
   *  "wss://" will use WebSockets, URLs starting with "http://", "https://"
   *  or without a protocol will use BOSH.
   *
   *  To make Strophe connect to the current host you can leave out the protocol
   *  and host part and just pass the path, e.g.
   *
   *  > const conn = new Connection("/http-bind/");
   *
   *  Parameters:
   *
   *    @param service - The BOSH or WebSocket service URL.
   *    @param options - A hash of configuration options
   *    @param authenticationMode
   *    @param prebindUrl
   *    @param boshServiceUrl
   *    @param websocketUrl
   *    @param credentialsUrl
   *    @param password
   *
   */
  private constructor(
    public service: string,
    readonly options: ConnectionOptions,
    readonly authenticationMode: AuthenticationMode,
    readonly prebindUrl?: string,
    readonly boshServiceUrl?: string,
    readonly websocketUrl?: string,
    readonly credentialsUrl?: string,
    readonly password?: string
  ) {
    this.protocolManager = this.createProtocolManager();
    /* stream:features */
    this.features = null;

    this.disconnectTimeout = null;

    this.authenticated = false;
    this.connected = false;
    this.disconnecting = false;

    // Max retries before disconnecting
    this.maxRetries = 5;

    // Call onIdle callback every 1/10th of a second
    // @ts-ignore
    this.idleTimeout = setTimeout(() => this.onIdle(), 100);

    addCookies(this.options.cookies);

    this.connectionStatus$.subscribe(({ status, reason }) =>
      this.onConnectStatusChanged(status, reason)
    );
  }

  /**
   * Select protocol based on the connections options or service
   */
  createProtocolManager(): ProtocolManager {
    const shouldBeBosh = !(
      this.service.startsWith('ws:') ||
      this.service.startsWith('wss:') ||
      this.options?.protocol?.includes('ws')
    );
    if (shouldBeBosh) {
      return new Bosh(this, this.prebindUrl);
    }

    if (this.protocolManager instanceof StropheWebsocket) {
      return this.protocolManager;
    }

    return new StropheWebsocket(this, this.stanzasInSubject);
  }

  /**
   *  Reset the connection.
   *
   *  This function should be called after a connection is disconnected
   *  before that connection is reused.
   */
  reset(): void {
    if (this.protocolManager instanceof Bosh) {
      this.protocolManager.reset();
    }

    // SASL
    this.sasl.doSession = false;
    this.sasl.doBind = false;

    this.handlerService.resetHandlers();

    this.authenticated = false;
    this.connected = false;
    this.disconnecting = false;
  }

  /**
   *  Generate a unique ID for use in <iq/> elements.
   *
   *  All <iq/> stanzas are required to have unique id attributes.  This
   *  function makes creating these easy.  Each connection instance has
   *  a counter which starts from zero, and the value of this counter
   *  plus a colon followed by the suffix becomes the unique id. If no
   *  suffix is supplied, the counter is used as the unique id.
   *
   *  Suffixes are used to make debugging easier when reading the stream
   *  data, and their use is recommended.  The counter resets to 0 for
   *  every new connection for the same reason.  For connections to the
   *  same server that authenticate the same way, all the ids should be
   *  the same, which makes it easy to see changes.  This is useful for
   *  automated testing as well.
   *
   *    @param suffix - A optional suffix to append to the id.
   *
   *    @returns A unique string to be used for the id attribute.
   */
  getUniqueId(suffix?: string | number): string {
    const uuid: string = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0,
        v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
    if (suffix) {
      return uuid + ':' + suffix;
    }

    return uuid;
  }

  /**
   *  Starts the connection process.
   *
   *  As the connection process proceeds, the connectionStatus$ emits the different status.
   *
   *  The status code will be one of the values in the Status constants.
   *  The error condition will be one of the conditions defined in RFC 3920 or the condition 'strophe-parsererror'.
   *
   *  @param jid - The user's JID.  This may be a bare JID,
   *      or a full JID.  If a node is not supplied, SASL ANONYMOUS
   *      authentication will be attempted.
   *  @param pass - The user's password.
   *  @param authcid - The optional alternative authentication identity
   *      (username) if intending to impersonate another user.
   *      When using the SASL-EXTERNAL authentication mechanism, for example
   *      with client certificates, then the authcid value is used to
   *      determine whether an authorization JID (authzid) should be sent to
   *      the server. The authzid should NOT be sent to the server if the
   *      authzid and authcid are the same. So to prevent it from being sent
   *      (for example when the JID is already contained in the client
   *      certificate), set authcid to that same JID. See XEP-178 for more
   *      details.
   *  @param [disconnectionTimeout=3000] - The optional disconnection timeout in milliseconds before doDisconnect will be called.
   */
  connect(jid?: string, pass?: string, authcid?: string, disconnectionTimeout?: number): void {
    if (!this.boshServiceUrl && !this.websocketUrl) {
      throw new Error(
        'You must supply a value for either the bosh_service_url or websocket_url or both.'
      );
    }

    this.jid = jid;

    this.sasl.setVariables(this.jid, pass, authcid);

    this.disconnecting = false;
    this.connected = false;
    this.authenticated = false;
    this.disconnectionTimeout = disconnectionTimeout;

    // parse jid for domain
    this.domain = getDomainFromJid(this.jid);

    this.connectionStatusSubject.next({ status: Status.CONNECTING });

    this.protocolManager.connect();
  }

  /**
   *  Send a stanza.
   *
   *  This function is called to push data onto the send queue to
   *  go out over the wire.  Whenever a request is sent to the BOSH
   *  server, all pending data is sent and the queue is flushed.
   *
   *  Parameters:
   *
   *  @param elem - The stanza to send.
   */
  send(elem: Element | Element[] | Builder): void {
    if (!elem) {
      return;
    }
    if (Array.isArray(elem)) {
      for (const el of elem) {
        this.protocolManager.send(el);
      }
    } else if (!(elem instanceof Element)) {
      this.protocolManager.send(elem.tree());
    } else {
      this.protocolManager.send(elem);
    }
  }

  /**
   *  Immediately send any pending outgoing data.
   *
   *  Normally send() queues outgoing data until the next idle period
   *  (100ms), which optimizes network use in the common cases when
   *  several send()s are called in succession. flush() can be used to
   *  immediately send all pending data.
   */
  flush(): void {
    // cancel the pending idle period and run the idle function
    // immediately
    clearTimeout(this.idleTimeout);
    this.onIdle();
  }

  /**
   *  Helper function to send presence stanzas. The main benefit is for
   *  sending presence stanzas for which you expect a responding presence
   *  stanza with the same id (for example when leaving a chat room).
   *
   *  Parameters:
   *
   *    @param el - The stanza to send.
   *    @param callback - The callback function for a successful request.
   *    @param errback - The callback function for a failed or timed
   *      out request.  On timeout, the stanza will be null.
   *    @param timeout - The time specified in milliseconds for a
   *      timeout to occur.
   *
   *  Returns:
   *    @returns The id used to send the presence.
   */
  sendPresence(
    el: Element | Builder,
    callback?: (elem: Element) => unknown,
    errback?: (elem: Element) => unknown,
    timeout?: number
  ): string {
    let timeoutHandler: TimedHandler = null;
    const elem = el instanceof Element ? el : el.tree();

    let id = elem.getAttribute('id');
    if (!id) {
      // inject id if not found
      id = this.getUniqueId('sendPresence');
      elem.setAttribute('id', id);
    }

    if (typeof callback === 'function' || typeof errback === 'function') {
      const handler = this.handlerService.addHandler(
        (stanza) => {
          // remove timeout handler if there is one
          if (timeoutHandler) {
            this.handlerService.deleteTimedHandler(timeoutHandler);
          }
          if (stanza.getAttribute('type') === 'error') {
            if (errback) {
              errback(stanza);
            }
          } else if (callback) {
            callback(stanza);
          }
          return false;
        },
        null,
        'presence',
        null,
        id
      );

      // if timeout specified, set up a timeout handler.
      if (timeout) {
        timeoutHandler = this.handlerService.addTimedHandler(timeout, () => {
          // get rid of normal handler
          this.handlerService.deleteHandler(handler);
          // call errback on timeout with null stanza
          if (errback) {
            errback(null);
          }
          return false;
        });
      }
    }
    this.send(elem);
    return id;
  }

  /**
   *  Helper function to send IQ stanzas.
   *
   *  Parameters:
   *
   *    @param el - T XMLElement ashe stanza to send.
   *    @param callback - The callback function for a successful request.
   *    @param errback - The callback function for a failed or timed
   *      out request.  On timeout, the stanza will be null.
   *    @param timeout - The time specified in milliseconds for a
   *      timeout to occur.
   *
   *  Returns:
   *    @returns The id used to send the IQ.
   */
  sendIQ(
    el: Element | Builder,
    callback?: (stanza: Element) => unknown,
    errback?: (stanza: Element) => unknown,
    timeout?: number
  ): string {
    const elem = el instanceof Element ? el : el.tree();

    let id = elem.getAttribute('id');
    if (!id) {
      // inject id if not found
      id = this.getUniqueId('sendIQ');
      elem.setAttribute('id', id);
    }

    let timeoutHandler: TimedHandler = null;
    if (typeof callback === 'function' || typeof errback === 'function') {
      const handler = this.handlerService.addHandler(
        (stanza) => {
          // remove timeout handler if there is one
          if (timeoutHandler) {
            this.handlerService.deleteTimedHandler(timeoutHandler);
          }
          const iqtype = stanza.getAttribute('type');
          if (iqtype === 'result') {
            if (callback) {
              callback(stanza);
            }
          } else if (iqtype === 'error') {
            if (errback) {
              errback(stanza);
            }
          } else {
            const stropheError = new Error(`Got bad IQ type of ${iqtype}`);
            stropheError.name = 'StropheError';
            throw stropheError;
          }
          return false;
        },
        null,
        'iq',
        ['error', 'result'],
        id
      );

      // if timeout specified, set up a timeout handler.
      if (timeout) {
        timeoutHandler = this.handlerService.addTimedHandler(timeout, () => {
          // get rid of normal handler
          this.handlerService.deleteHandler(handler);
          // call errback on timeout with null stanza
          if (errback) {
            errback(null);
          }
          return false;
        });
      }
    }
    this.send(elem);
    return id;
  }

  observeForMatch$(options?: MatcherConfig): Observable<Element> {
    return this.stanzasIn$.pipe(filter((elem) => new Matcher(options).isMatch(elem)));
  }

  /**
   *  Start the graceful disconnection process.
   *
   *  This function starts the disconnection process.  This process starts
   *  by sending unavailable presence and sending BOSH body of type
   *  terminate.  A timeout handler makes sure that disconnection happens
   *  even if the BOSH server does not respond.
   *  If the Connection object isn't connected, at least tries to abort all pending requests
   *  so the connection object won't generate successful requests (which were already opened).
   *
   *  The user supplied connection callback will be notified of the
   *  progress as this process happens.
   *
   *  Parameters:
   *
   *    @param reason - The reason the disconnect is occuring.
   */
  disconnect(reason?: string): void {
    this.connectionStatusSubject.next({ status: Status.DISCONNECTING, reason });
    info('Disconnect was called; reason=' + reason);
    if (!this.connected) {
      warn('Disconnect was called before Strophe connected to the server');
      if (this.protocolManager instanceof Bosh) {
        this.protocolManager.abortAllRequests();
      }
      this.doDisconnect();
      return;
    }

    // TODO: move into a finally in the connections
    // setup timeout handler
    const timeOut = this.disconnectionTimeout ?? 3000;
    this.disconnectTimeout = this.handlerService.addSysTimedHandler(timeOut, () =>
      this.onDisconnectTimeout()
    );
    this.disconnecting = true;

    if (!this.authenticated) {
      this.protocolManager.disconnect();
      return;
    }

    this.protocolManager.disconnect(
      $pres({
        xmlns: NS.CLIENT,
        type: 'unavailable',
      }).tree()
    );
  }

  /**
   *
   *  This is the last piece of the disconnection logic.  This resets the
   *  connection and alerts the user's connection callback.
   */
  doDisconnect(reason?: string): void {
    clearTimeout(this.idleTimeout);

    // Cancel Disconnect Timeout
    if (this.disconnectTimeout != null) {
      this.handlerService.deleteTimedHandler(this.disconnectTimeout);
      this.disconnectTimeout = null;
    }

    debug('doDisconnect was called');
    this.protocolManager.doDisconnect();

    this.authenticated = false;
    this.disconnecting = false;

    // delete handlers
    this.handlerService.resetHandlers();

    // tell the parent we disconnected
    this.connectionStatusSubject.next({ status: Status.DISCONNECTED, reason });
    this.connected = false;
  }

  /**
   * Set up authentication
   *
   *  Continues the initial connection request by setting up authentication
   *  handlers and starting the authentication process.
   *
   *  SASL authentication will be attempted if available, otherwise
   *  the code will fall back to legacy authentication.
   *
   *  Parameters:
   *
   *    @param matched - Array of SASL mechanisms supported.
   *
   */
  async authenticate(matched: SASLMechanism[]): Promise<void> {
    const saslAuth = await this.sasl.attemptSASLAuth(matched);
    if (saslAuth) {
      return;
    }

    this.attemptLegacyAuth();
  }

  /**
   *
   *  Attempt legacy (i.e. non-SASL) authentication.
   */
  attemptLegacyAuth(): void {
    if (getNodeFromJid(this.jid) === null) {
      // we don't have a node, which is required for non-anonymous
      // client connections
      this.connectionStatusSubject.next({
        status: Status.CONNFAIL,
        reason: ErrorCondition.MISSING_JID_NODE,
      });
      this.disconnect(ErrorCondition.MISSING_JID_NODE);
    } else {
      // Fall back to legacy authentication
      this.connectionStatusSubject.next({ status: Status.AUTHENTICATING });
      this.handlerService.addSysHandler(
        (elem) => this.onLegacyAuthIQResult(elem),
        null,
        null,
        null,
        '_auth_1'
      );
      this.send(
        $iq({
          type: 'get',
          to: this.domain,
          id: '_auth_1',
        })
          .c('query', { xmlns: NS.AUTH })
          .c('username', {})
          .t(getNodeFromJid(this.jid))
          .tree()
      );
    }
  }

  /**
   *  handler for legacy authentication.
   *
   *  This handler is called in response to the initial <iq type='get'/>
   *  for legacy authentication.  It builds an authentication <iq/> and
   *  sends it, creating a handler (calling back to _auth2_cb()) to
   *  handle the result
   *
   *   @param _elem - The stanza that triggered the callback.
   *
   *   @returns false to remove the handler.
   */
  onLegacyAuthIQResult(_elem: Element): false {
    // build plaintext auth iq
    const iq = $iq({ type: 'set', id: '_auth_2' })
      .c('query', { xmlns: NS.AUTH })
      .c('username', {})
      .t(getNodeFromJid(this.jid))
      .up()
      .c('password')
      .t(this.sasl.pass as string);

    if (!getResourceFromJid(this.jid)) {
      // since the user has not supplied a resource, we pick
      // a default one here.  unlike other auth methods, the server
      // cannot do this for us.
      this.jid = getBareJidFromJid(this.jid) + '/strophe';
    }
    iq.up().c('resource', {}).t(getResourceFromJid(this.jid));

    this.handlerService.addSysHandler(
      (element) => this.auth2Callback(element),
      null,
      null,
      null,
      '_auth_2'
    );
    this.send(iq.tree());
    return false;
  }

  /**
   *
   *  Sends an IQ to the XMPP server to bind a JID resource for this session.
   *
   *  https://tools.ietf.org/html/rfc6120#section-7.5
   *
   *  If `explicitResourceBinding` was set to a truthy value in the options
   *  passed to the Connection constructor, then this function needs
   *  to be called explicitly by the client author.
   *
   *  Otherwise, it'll be called automatically as soon as the XMPP server
   *  advertises the "urn:ietf:params:xml:ns:xmpp-bind" stream feature.
   */
  bind(): void {
    if (!this.sasl.doBind) {
      return;
    }

    this.handlerService.addSysHandler(
      (element) => this.onResourceBindResultIQ(element),
      null,
      null,
      null,
      '_bind_auth_2'
    );

    const resource = getResourceFromJid(this.jid);
    if (resource) {
      this.send(
        $iq({ type: 'set', id: '_bind_auth_2' })
          .c('bind', { xmlns: NS.BIND })
          .c('resource', {})
          .t(resource)
          .tree()
      );
    } else {
      this.send($iq({ type: 'set', id: '_bind_auth_2' }).c('bind', { xmlns: NS.BIND }).tree());
    }
  }

  /**
   *  Handler for binding result and session start.
   *
   *    @param elem - The matching stanza.
   *
   *    @returns false to remove the handler.
   */
  onResourceBindResultIQ(elem: Element): boolean {
    if (elem.getAttribute('type') === 'error') {
      warn('Resource binding failed.');
      const conflict = elem.getElementsByTagName('conflict');
      let reason;
      if (conflict.length > 0) {
        reason = ErrorCondition.CONFLICT;
      }
      this.connectionStatusSubject.next({ status: Status.AUTHFAIL, reason, elem });
      return false;
    }
    // TODO - need to grab errors
    const bind = elem.getElementsByTagName('bind');
    if (bind.length > 0) {
      const jidNode = bind[0].getElementsByTagName('jid');
      if (jidNode.length > 0) {
        this.authenticated = true;
        this.jid = getText(jidNode[0]);
        if (this.sasl.doSession) {
          this.establishSession();
        } else {
          this.connectionStatusSubject.next({ status: Status.CONNECTED });
        }
      }
      return true;
    } else {
      warn('Resource binding failed.');
      this.connectionStatusSubject.next({ status: Status.AUTHFAIL, elem });
      return false;
    }
  }

  /**
   *  Send IQ request to establish a session with the XMPP server.
   *
   *  See https://xmpp.org/rfcs/rfc3921.html#session
   *
   *  Note: The protocol for session establishment has been determined as
   *  unnecessary and removed in RFC-6121.
   */
  establishSession(): void {
    if (!this.sasl.doSession) {
      throw new Error(
        `Strophe.Connection.prototype._establishSession ` +
          `called but apparently ${NS.SESSION} wasn't advertised by the server`
      );
    }
    this.handlerService.addSysHandler(
      (element) => this.onSessionResultIQ(element),
      null,
      null,
      null,
      '_session_auth_2'
    );

    this.send(
      $iq({ type: 'set', id: '_session_auth_2' }).c('session', { xmlns: NS.SESSION }).tree()
    );
  }

  /**
   *  Handler for the server's IQ response to a client's session request.
   *
   *  This sets Authenticated to true on success, which starts the processing of user handlers.
   *
   *  See https://xmpp.org/rfcs/rfc3921.html#session
   *
   *  Note: The protocol for session establishment has been determined as unnecessary and removed in RFC-6121.
   *
   * @param elem - The matching stanza.
   *
   * @returns false to remove the handler.
   */
  onSessionResultIQ(elem: Element): false {
    if (elem.getAttribute('type') === 'result') {
      this.authenticated = true;
      this.connectionStatusSubject.next({ status: Status.CONNECTED });
    } else if (elem.getAttribute('type') === 'error') {
      this.authenticated = false;
      warn('Session creation failed.');
      this.connectionStatusSubject.next({ status: Status.AUTHFAIL, elem });
      return false;
    }
    return false;
  }

  /**
   * Finish legacy authentication.
   * This handler is called when the result from the jabber:iq:auth <iq/> stanza is returned.
   *
   * @param elem - The stanza that triggered the callback.
   *
   * @returns false to remove the handler.
   */
  auth2Callback(elem: Element): false {
    if (elem.getAttribute('type') === 'result') {
      this.authenticated = true;
      this.connectionStatusSubject.next({ status: Status.CONNECTED });
    } else if (elem.getAttribute('type') === 'error') {
      this.connectionStatusSubject.next({ status: Status.AUTHFAIL, elem });
      this.disconnect('authentication failed');
    }
    return false;
  }

  /**
   *  timeout handler for handling non-graceful disconnection.
   *
   *  If the graceful disconnect process does not complete within the
   *  time allotted, this handler finishes the disconnect anyway.
   *
   *  Returns:
   *    false to remove the handler.
   */
  onDisconnectTimeout(): false {
    this.connectionStatusSubject.next({ status: Status.CONNTIMEOUT });
    if (this.protocolManager instanceof Bosh) {
      this.protocolManager.onDisconnectTimeout();
    }
    // actually disconnect
    this.doDisconnect();
    return false;
  }

  /**
   *  helper function that makes sure plugins and the user's callback are notified of connection status changes.
   *
   *    @param status - the new connection status, one of the values in Status
   *    @param reason - the error condition or null
   *    @param elem - The triggering stanza.
   */
  changeConnectStatus(status: number, reason?: string, elem?: Element): void {
    this.connectionStatusSubject.next({ status, reason, elem });
  }

  /**
   *  handler to processes incoming data from the BOSH connection.
   *
   *  Except for connectCb handling the initial connection request,
   *  this function handles the incoming data for all requests.  This
   *  function also fires stanza handlers that match each incoming
   *  stanza.
   *
   *  Parameters:
   *
   *    @param bosh - The bosh connection.
   *    @param req - The request that has data ready.
   */
  async dataReceivedBOSH(bosh: Bosh, req: BoshRequest): Promise<void> {
    const elem: Element = bosh.reqToData(req);
    await this.dataReceived(elem, this.disconnecting && bosh.emptyQueue());
  }

  /**
   *  handler to processes incoming data from the connection.
   *
   *  Except for _connect_cb handling the initial connection request,
   *  this function handles the incoming data for all requests.  This
   *  function also fires stanza handlers that match each incoming
   *  stanza.
   *
   *  Parameters:
   *
   *    @param elem - The request that has data ready.
   */
  async dataReceivedWebsocket(elem: Element): Promise<void> {
    await this.dataReceived(elem, this.disconnecting);
  }

  private async dataReceived(elem: Element, handleDisconnect: boolean): Promise<void> {
    if (elem == null) {
      return;
    }

    this.xmlInput?.(elem);
    this.stanzasInSubject.next(elem);

    this.handlerService.removeScheduledHandlers();
    this.handlerService.addScheduledHandlers();

    // handle graceful disconnect
    if (handleDisconnect) {
      this.doDisconnect();
      return;
    }

    const type = elem.getAttribute('type');
    if (type === 'terminate') {
      // an error occurred
      const reason = elem.getAttribute('condition');
      const conflict = elem.getElementsByTagName('conflict');
      if (reason == null) {
        this.connectionStatusSubject.next({
          status: Status.CONNFAIL,
          reason: ErrorCondition.UNKNOWN_REASON,
        });
      } else {
        this.connectionStatusSubject.next({
          status: Status.CONNFAIL,
          reason: reason === 'remote-stream-error' && conflict.length > 0 ? 'conflict' : reason,
        });
      }
      this.doDisconnect(reason);
      return;
    }

    // send each incoming stanza through the handler chain
    await this.handlerService.checkHandlerChain(this.authenticated, elem);
  }

  /**
   *  handler to process events during idle cycle.
   *
   *  This handler is called every 100ms to fire timed handlers that
   *  are ready and keep poll requests going.
   */
  onIdle(): void {
    this.handlerService.addTimedHandlersScheduledForAddition();
    this.handlerService.removeTimedHandlersScheduledForDeletion();
    this.handlerService.callReadyTimedHandlers(this.authenticated);

    clearTimeout(this.idleTimeout);
    if (this.protocolManager instanceof Bosh) {
      this.protocolManager.onIdle();
    }

    if (!this.connected) {
      return;
    }
    // reactivate the timer only if connected
    this.idleTimeout = setTimeout(() => this.onIdle(), 100);
  }

  /**
   *  This handler is used to process the initial connection request
   *  response from the Websocket server. It is used to set up authentication
   *  handlers and start the authentication process.
   *
   *  SASL authentication will be attempted if available, otherwise
   *  the code will fall back to legacy authentication.
   *
   *  @param websocket - The current websocket connection.
   *  @param element - The current element coming from the Websocket.
   */
  async connectCallbackWebsocket(websocket: StropheWebsocket, element: Element): Promise<void> {
    this.connected = true;

    const matched = this.getMatchedAuthentications(websocket, element);
    if (matched.length > 0) {
      return this.authenticate(matched);
    }

    websocket.noAuthReceived();
  }

  /**
   *  This handler is used to process the initial connection request
   *  response from the BOSH server. It is used to set up authentication
   *  handlers and start the authentication process.
   *
   *  SASL authentication will be attempted if available, otherwise
   *  the code will fall back to legacy authentication.
   *
   *  @param bosh - The current bosh connection.
   *  @param requestElement - The current request.
   */
  connectCallbackBosh(bosh: Bosh, requestElement: BoshRequest): void {
    this.connected = true;

    let wrappedBody: Element;
    try {
      wrappedBody = bosh.reqToData(requestElement);
    } catch (e) {
      if (e.name !== ErrorCondition.BAD_FORMAT) {
        throw e;
      }
      this.connectionStatusSubject.next({
        status: Status.CONNFAIL,
        reason: ErrorCondition.BAD_FORMAT,
      });
      this.doDisconnect(ErrorCondition.BAD_FORMAT);
    }

    const matched = this.getMatchedAuthentications(bosh, wrappedBody);
    if (matched.length > 0) {
      this.authenticate(matched).then();
    }

    bosh.noAuthReceived();
  }

  static async create(
    service: string,
    domain: string,
    authenticationMode = AuthenticationMode.LOGIN,
    prebindUrl?: string,
    credentialsUrl?: string
  ): Promise<Connection> {
    if (Connection.instance) {
      return Connection.instance;
    }

    const connectionUrls = this.getConnectionsUrls(service, domain);
    const options = { keepalive: true, explicitResourceBinding: true };

    if (!connectionUrls.boshServiceUrl && !connectionUrls.websocketUrl && connectionUrls.domain) {
      const { boshServiceUrl, websocketUrl } = await this.discoverConnectionMethods(
        connectionUrls.domain
      );
      if (boshServiceUrl && authenticationMode === AuthenticationMode.PREBIND) {
        throw new Error("authentication is set to 'prebind' but we don't have a BOSH connection");
      }
      Connection.instance = new Connection(
        websocketUrl ?? boshServiceUrl,
        options,
        authenticationMode,
        prebindUrl,
        boshServiceUrl,
        websocketUrl,
        credentialsUrl
      );

      Connection.instance.sasl.registerSASLMechanisms();
      return Connection.instance;
    }

    const connectionUrl = connectionUrls.websocketUrl ?? connectionUrls.boshServiceUrl;
    Connection.instance = new Connection(
      connectionUrl,
      options,
      authenticationMode,
      prebindUrl,
      connectionUrls.boshServiceUrl,
      connectionUrls.websocketUrl,
      credentialsUrl
    );

    Connection.instance.sasl.registerSASLMechanisms();
    return Connection.instance;
  }

  static getConnectionsUrls(
    service: string,
    domain: string
  ): { domain: string; websocketUrl: string; boshServiceUrl: string } {
    const isWebsocket = /wss?:\/\//.test(service);

    return {
      domain,
      boshServiceUrl: isWebsocket ? undefined : service,
      websocketUrl: isWebsocket ? service : undefined,
    };
  }

  /**
   * Logs the user in.
   *
   * If called without any parameters, we will try to log the user in by calling the `prebind_url` or `credentials_url` depending
   * on whether prebinding is used or not.
   *
   * @param {string} [jid]
   * @param {string} [password?]
   * @param {boolean} [automatic=false] - An internally used flag that indicates whether
   *  this method was called automatically once the connection has been
   *  initialized. It's used together with the `auto_login` configuration flag
   *  to determine whether Converse should try to log the user in if it
   *  fails to restore a previous authenticated session.
   */
  async login(jid: string, password?: string, automatic = false): Promise<void> {
    this.jid = jid;

    // See whether there is a BOSH session to re-attach to
    if (this.protocolManager instanceof Bosh && this.protocolManager.restoreBOSHSession()) {
      return;
    }

    const handlePreBind =
      this.authenticationMode === AuthenticationMode.PREBIND && !!this.prebindUrl;
    if (this.protocolManager instanceof Bosh && handlePreBind && !automatic) {
      return this.protocolManager.startNewPreboundBOSHSession();
    }

    await this.attemptNewSession(this.authenticationMode, jid, password, automatic);
  }

  /**
   * Logs the user in without a jid.
   *
   * @param username the local name part of the jid on the xmpp server account
   * @param domain the domain of the xmpp server one is connecting to
   * @param {string} [password?] authenticating password
   * @param {boolean} [automatic=false] - An internally used flag that indicates whether
   *  this method was called automatically once the connection has been
   *  initialized. It's used together with the `auto_login` configuration flag
   *  to determine whether Converse should try to log the user in if it
   *  fails to restore a previous authenticated session.
   */
  async loginWithoutJid(
    username: string,
    domain: string,
    password?: string,
    automatic = false
  ): Promise<void> {
    const separator = '@';
    const safeUsername = username.includes(separator) ? username.split(separator)[0] : username;
    const jid = safeUsername + separator + domain;
    return this.login(jid, password, automatic);
  }

  createConnectionStatusHandler(): (status: Status, value: string) => Promise<void> {
    return async (status: Status, value: string) => {
      log(LogLevel.INFO, `status update; status=${status}, value=${JSON.stringify(value)}`);
      await this.onConnectStatusChanged(status, value);
    };
  }

  /**
   * Adds support for XEP-0156 by querying the XMPP server for alternate
   * connection methods. This allows users to use the websocket or BOSH
   * connection of their own XMPP server
   *
   * @param domain the xmpp server domain to requests the connection urls from
   */
  static async discoverConnectionMethods(
    domain: string
  ): Promise<{ websocketUrl: string; boshServiceUrl: string }> {
    // Use XEP-0156 to check whether this host advertises websocket or BOSH connection methods.
    const options = {
      mode: 'cors' as RequestMode,
      headers: {
        Accept: 'application/xrd+xml, text/xml',
      },
    };
    const url = `https://${domain}/.well-known/host-meta`;
    let response: globalThis.Response;
    try {
      response = await fetch(url, options);
    } catch (e) {
      log(LogLevel.ERROR, `Failed to discover alternative connection methods at ${url}`);
      log(LogLevel.ERROR, e);
      return null;
    }
    if (response.status >= 200 && response.status < 400) {
      const text = await response.text();
      return this.onDomainDiscovered(text);
    }

    log(LogLevel.WARN, 'Could not discover XEP-0156 connection methods');
    return null;
  }

  static onDomainDiscovered(xmlBody: string): { websocketUrl: string; boshServiceUrl: string } {
    const discoNS = 'http://docs.oasis-open.org/ns/xri/xrd-1.0';
    const xrd = new window.DOMParser().parseFromString(xmlBody, 'text/xml').firstElementChild;
    if (xrd.nodeName != 'XRD' || xrd.getAttribute('xmlns') != discoNS) {
      log(LogLevel.WARN, 'Could not discover XEP-0156 connection methods');
      return null;
    }

    const bosh_links = xrd.querySelectorAll(`Link[rel="urn:xmpp:alt-connections:xbosh"]`);
    const ws_links = xrd.querySelectorAll(`Link[rel="urn:xmpp:alt-connections:websocket"]`);
    const bosh_methods = Array.from(bosh_links).map((el) => el.getAttribute('href'));
    const ws_methods = Array.from(ws_links).map((el) => el.getAttribute('href'));

    if (bosh_methods.length !== 0 && ws_methods.length !== 0) {
      log(
        LogLevel.WARN,
        'Neither BOSH nor WebSocket connection methods have been specified with XEP-0156.'
      );
      return null;
    }

    const websocketUrl = ws_methods.pop();
    const boshServiceUrl = bosh_methods.pop();
    return { websocketUrl, boshServiceUrl };
  }

  async attemptNewSession(
    mode: AuthenticationMode,
    jid: string,
    password: string,
    automatic = false
  ): Promise<void> {
    if ([AuthenticationMode.ANONYMOUS, AuthenticationMode.EXTERNAL].includes(mode) && !automatic) {
      await this.connect(jid);
      return;
    }

    if (mode !== AuthenticationMode.LOGIN) {
      throw new Error('Invalid mode for new session authentication; mode=' + mode);
    }

    if (!password) {
      // We give credentials_url preference, because connection.pass might be an expired token.
      const credentials = await this.getLoginCredentials(this.credentialsUrl);
      password = credentials.password;
      jid = credentials.jid ?? jid;
    }

    // XXX: If EITHER ``keepalive`` or ``auto_login`` is ``true`` and
    // ``authentication`` is set to ``login``, then Converse will try to log the user in,
    // since we don't have a way to distinguish between whether we're
    // restoring a previous session (``keepalive``) or whether we're
    // automatically setting up a new session (``auto_login``).
    // So we can't do the check (!automatic || _converse.api.settings.get("auto_login")) here.
    password = password ?? (this.sasl.pass as string) ?? this.password;

    if (jid && password != null) {
      await this.connect(jid, password);
      return;
    }

    const reason = '';
    this.connectionStatusSubject.next({ status: Status.AUTHFAIL, reason });
    this.disconnect(reason);
  }

  async getLoginCredentialsFromBrowser(): Promise<{ password: any; jid: string }> {
    try {
      // https://github.com/microsoft/TypeScript/issues/34550
      const creds = await navigator.credentials.get({ password: true } as unknown);
      if (creds && creds.type == 'password' && Connection.isValidJID(creds.id)) {
        this.jid = creds.id;
        return { jid: creds.id, password: (creds as unknown as any).password };
      }
    } catch (e) {
      log(LogLevel.ERROR, e);
    }
    return null;
  }

  private static isValidJID(jid: string): boolean {
    if (typeof jid === 'string') {
      return jid.trim().split('@').length === 2 && !jid.startsWith('@') && !jid.endsWith('@');
    }
    return false;
  }

  async getLoginCredentials(credentialsURL: string): Promise<Credentials> {
    if (!credentialsURL && 'credentials' in navigator) {
      return this.getLoginCredentialsFromBrowser();
    }

    let credentials;
    let wait = 0;
    while (!credentials) {
      try {
        credentials = await this.fetchLoginCredentials(wait, credentialsURL);
      } catch (e) {
        log(LogLevel.ERROR, 'Could not fetch login credentials');
        log(LogLevel.ERROR, e);
      }
      // If unsuccessful, we wait 2 seconds between subsequent attempts to
      // fetch the credentials.
      wait = 2000;
    }
    return credentials;
  }

  async fetchLoginCredentials(wait = 0, credentialsURL: string): Promise<Credentials> {
    return firstValueFrom(
      fromRxjs<Promise<Credentials>>(BoshRequest.get<Credentials>(credentialsURL)).pipe(
        debounceTime(wait)
      )
    );
  }

  static generateResource(): string {
    return `/ngx-chat-${Math.floor(Math.random() * 139749528).toString()}`;
  }

  /**
   * Switch to a different transport if a service URL is available for it.
   *
   * When reconnecting with a new transport, we call setUserJID
   * so that a new resource is generated, to avoid multiple
   * server-side sessions with the same resource.
   *
   * We also call `_proto._doDisconnect` so that connection event handlers
   * for the old transport are removed.
   */
  switchTransport(): void {
    this.doDisconnect();
    if (this.protocolManager instanceof StropheWebsocket && this.boshServiceUrl) {
      this.service = this.boshServiceUrl;
    } else if (this.protocolManager instanceof Bosh && this.websocketUrl) {
      this.service = this.websocketUrl;
    }
    this.protocolManager = this.createProtocolManager();
  }

  async reconnect(): Promise<void> {
    log(LogLevel.DEBUG, 'RECONNECTING: the connection has dropped, attempting to reconnect.');
    const { status } = await firstValueFrom(this.connectionStatus$);
    if (status === Status.CONNFAIL) {
      this.switchTransport();
    }

    this.connectionStatusSubject.next({
      status: Status.RECONNECTING,
      reason: 'The connection has dropped, attempting to reconnect.',
    });
    /**
     * Triggered when the connection has dropped, but we will attempt
     * to reconnect again.
     */
    this.willReconnectSubject.next();

    this.reset();
    await this.login(this.jid);
    await firstValueFrom(this.onOnline$);
  }

  async logOut(): Promise<void> {
    await new Promise((resolve) => this.sendPresence($pres({ type: 'unavailable' }), resolve));
    this.connectionStatusSubject.next({ status: Status.DISCONNECTED }); // after last send
    this.disconnect('regular logout');
    this.reset();
  }

  /**
   * Promise resolves if user account is registered successfully,
   * rejects if an error happens while registering, e.g. the username is already taken.
   */
  async register(
    username: string,
    password: string,
    service: string,
    domain: string
  ): Promise<void> {
    return register(username, password, service, domain);
  }

  finishDisconnection(): void {
    // Properly tear down the session so that it's possible to manually connect again.
    log(LogLevel.DEBUG, 'DISCONNECTED');
    this.reset();
    this.clearSession();
  }

  /**
   * Gets called once strophe's status reaches Status.DISCONNECTED.
   * Will either start a teardown process for converse.js or attempt
   * to reconnect.
   *
   */
  private async onDisconnected(
    disconnectionStatus: Status,
    disconnectionReason: string,
    automaticLogin?: boolean
  ): Promise<void> {
    if (!automaticLogin) {
      await this.finishDisconnection();
      return;
    }

    const authFailed = disconnectionStatus === Status.AUTHFAIL;

    // If `credentials_url` is set, we reconnect, because we might
    // be receiving expired tokens from the credentials_url.
    const failedAuthenticationWithCredentialsUrl = authFailed && this.credentialsUrl;

    // If `authentication` is anonymous, we reconnect because we
    // might have tried to attach with stale BOSH session tokens
    // or with a cached JID and password
    const isConnectionAnonymous = this.authenticationMode === AuthenticationMode.ANONYMOUS;

    const unrecoverableDisconnectionCause = [
      ErrorCondition.NO_AUTH_MECH,
      'host-unknown',
      'remote-connection-failed',
    ].includes(disconnectionReason);
    const isAbleToReconnect =
      disconnectionStatus !== Status.DISCONNECTING || unrecoverableDisconnectionCause;

    if (failedAuthenticationWithCredentialsUrl || isConnectionAnonymous || isAbleToReconnect) {
      await this.reconnect();
      return;
    }

    this.finishDisconnection();
    return;
  }

  /**
   * Callback method called by Strophe as the Connection goes
   * through various states while establishing or tearing down a connection.
   *
   * @param {number} status
   * @param {string} reason
   */
  async onConnectStatusChanged(status: Status, reason: string): Promise<void> {
    switch (status) {
      case Status.REDIRECT:
      case Status.CONNTIMEOUT:
      case Status.RECONNECTING:
      case Status.REGIFAIL:
      case Status.REGISTER:
      case Status.REGISTERED:
      case Status.CONFLICT:
      case Status.NOTACCEPTABLE:
        break;
      case Status.CONNECTING:
      case Status.AUTHENTICATING:
        this.onBeforeOnlineSubject.next(this.jid);
        break;
      case Status.ERROR:
      case Status.CONNFAIL:
      case Status.DISCONNECTING:
      case Status.ATTACHFAIL:
        this.connectionStatusSubject.next({ status, reason });
        this.onOfflineSubject.next();
        break;
      case Status.DISCONNECTED:
      case Status.AUTHFAIL:
        this.connectionStatusSubject.next({ status, reason });
        await this.onDisconnected(status, reason);
        this.onOfflineSubject.next();
        break;
      case Status.CONNECTED:
      case Status.ATTACHED:
        this.connectionStatusSubject.next({ status, reason });
        // Solves problem of returned PubSub BOSH response not received by browser
        this.flush();
        this.afterResourceBindingSubject.next();
        this.onOnlineSubject.next();
        break;
      case Status.BINDREQUIRED:
        this.bind();
        break;
      default:
        throw new Error('Unknown connection state; status=' + status);
    }
  }

  clearSession(): void {
    this.protocolManager = this.createProtocolManager();
  }

  private getMatchedAuthentications(
    protocolManager: ProtocolManager,
    element: Element
  ): SASLMechanism[] {
    if (!element) {
      return [];
    }

    this.xmlInput?.(element);

    const connectionCheck = protocolManager.connectCb(element);

    if (connectionCheck === Status.CONNFAIL) {
      return [];
    }

    const hasFeatures = element.getAttribute('xmlns:stream') === NS.STREAM;

    if (!hasFeatures) {
      protocolManager.noAuthReceived();
      return [];
    }

    return Array.from(element.getElementsByTagName('mechanism'))
      .map((m) => this.sasl.mechanism[m.textContent])
      .filter((m) => m);
  }
}
