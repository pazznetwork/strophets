import { SASLMechanism } from './sasl-mechanism';
import { TimedHandler } from './timed-handler';
import { Status } from './status';
import { Builder } from './builder';
import { addCookies } from './utils';
import { NS } from './namespace';
import { forEachChild, getBareJidFromJid, getDomainFromJid, getNodeFromJid, getResourceFromJid, getText } from './xml';
import { ErrorCondition, handleError } from './error';
import { $iq, $pres } from './builder-helper';
import { debug, info, log, LogLevel, warn } from './log';
import { Bosh } from './bosh';
import { StropheWebsocket } from './websocket';
import { ProtocolManager } from './protocol-manager';
import { debounceTime, filter, firstValueFrom, from as fromRxjs, Observable, share, shareReplay, startWith, Subject } from 'rxjs';
import { Matcher, MatcherConfig } from './matcher';
import { ConnectionOptions } from './connection-options';
import { AuthenticationMode } from './authentication-mode';
import { Credentials } from './credentials';
import { Sasl } from './sasl';
import { HandlerService } from './handler-service';

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
  /**
   * variable that keeps track of the request ids for connections.
   */
  private static requestId = 0;

  /**
   * The connected JID.
   */
  jid = '';

  private readonly userJidSubject = new Subject<string>();
  private readonly willReconnectSubject = new Subject<void>();

  userJid$: Observable<string> = this.userJidSubject.pipe(share());
  willReconnect$: Observable<void> = this.willReconnectSubject.pipe(share());

  /**
   * The domain of the connected JID.
   */
  domain: string = null;
  features: Element;

  authenticated: boolean;
  connected: boolean;
  disconnecting: boolean;
  do_authentication: boolean;
  paused: boolean;

  maxRetries: number;

  status: Status;

  /** parameter: callback
   *  Set on connection.
   *  Callback after connecting.
   */
  connectCallback: (status: number, condition: string, elem: Element) => unknown;

  disconnection_timeout: number;

  private stanzasInSubject = new Subject<Element>();
  stanzasIn$ = this.stanzasInSubject.pipe(share());
  private stanzasOutSubject = new Subject<Element>();
  stanzasOut$ = this.stanzasOutSubject.pipe(share());

  protected readonly stateSubject = new Subject<Status>();
  readonly state$ = this.stateSubject.pipe(startWith(Status.DISCONNECTED), shareReplay(1));

  private afterResourceBindingSubject = new Subject<void>();
  private reconnectedSubject = new Subject<void>();
  private connectedSubject = new Subject<void>();
  private disconnectedSubject = new Subject<void>();

  private reconnecting = false;

  private readonly connectionStatusSubject = new Subject<{ status: Status; message: string }>();
  readonly connectionStatus$ = this.connectionStatusSubject.asObservable();

  private session: Record<string, unknown>;
  private bareJid: string;
  private domainJid: string;

  /**
   * protocol used for connection
   */
  protocolManager: ProtocolManager;

  idleTimeout: number;
  private disconnectTimeout: TimedHandler;
  data: Element[];
  private uniqueId: number;

  readonly sasl = new Sasl(this);

  readonly handlerService = new HandlerService(this);

  get handlePreBind(): boolean {
    return this.authenticationMode === AuthenticationMode.PREBIND && !!this.prebindUrl;
  }

  /**
   * Stores the passed in JID for the current user, potentially creating a
   * resource if the JID is bare.
   *
   * @emits userJidSubject
   * @param {string} jid
   */
  setUserJID(jid: string): string {
    /**
     * Triggered whenever the user's JID has been updated
     */
    this.jid = jid;
    this.userJidSubject.next(this.jid);
    return this.jid;
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
    this.setProtocol();
    /* stream:features */
    this.features = null;

    this.idleTimeout = null;
    this.disconnectTimeout = null;

    this.authenticated = false;
    this.connected = false;
    this.disconnecting = false;
    this.do_authentication = true;
    this.paused = false;

    this.data = [];
    this.uniqueId = 0;

    // Max retries before disconnecting
    this.maxRetries = 5;

    // Call onIdle callback every 1/10th of a second
    // @ts-ignore
    this.idleTimeout = setTimeout(() => this._onIdle(), 100);

    addCookies(this.options.cookies);

    // initialize plugins
    for (const [key, value] of connectionPlugins.entries()) {
      const plugin = new value();
      plugin.init(this);
      this[key] = plugin;
    }
  }

  /**
   *  Select protocol based on this.options or this.service
   */
  setProtocol(): void {
    const proto = this.options.protocol || '';
    if (this.service.includes('ws:') || this.service.includes('wss:') || proto.includes('ws')) {
      this.protocolManager = new StropheWebsocket(this, this.stanzasInSubject);
    } else {
      this.protocolManager = new Bosh(this, this.prebindUrl);
    }
  }

  /**
   *  Reset the connection.
   *
   *  This function should be called after a connection is disconnected
   *  before that connection is reused.
   */
  reset(): void {
    this.protocolManager.reset();

    // SASL
    this.sasl.doSession = false;
    this.sasl.doBind = false;

    this.handlerService.resetHandlers();

    this.authenticated = false;
    this.connected = false;
    this.disconnecting = false;

    this.data = [];
    this.uniqueId = 0;
  }

  /**
   *  Pause the request manager.
   *
   *  This will prevent Strophe from sending any more requests to the
   *  server.  This is very useful for temporarily pausing
   *  BOSH-Connections while a lot of send() calls are happening quickly.
   *  This causes Strophe to send the data in a single request, saving
   *  many request trips.
   */
  pause(): void {
    this.paused = true;
  }

  /**
   *  Resume the request manager.
   *
   *  This resumes after pause() has been called.
   */
  resume(): void {
    this.paused = false;
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
   *  Parameters:
   *
   *    @param suffix - A optional suffix to append to the id.
   *
   *  Returns:
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
   *  As the connection process proceeds, the user supplied callback will
   *  be triggered multiple times with status updates.  The callback
   *  should take two arguments - the status code and the error condition.
   *
   *  The status code will be one of the values in the Status
   *  constants.  The error condition will be one of the conditions
   *  defined in RFC 3920 or the condition 'strophe-parsererror'.
   *
   *  The Parameters _wait_, _hold_ and _route_ are optional and only relevant
   *  for BOSH connections. Please see XEP 124 for a more detailed explanation
   *  of the optional parameters.
   *
   *  Parameters:
   *
   *    @param jid - The user's JID.  This may be a bare JID,
   *      or a full JID.  If a node is not supplied, SASL ANONYMOUS
   *      authentication will be attempted.
   *    @param pass - The user's password.
   *    @param callback - The connect callback function.
   *    @param wait - The optional HTTPBIND wait value.  This is the
   *      time the server will wait before returning an empty result for
   *      a request.  The default setting of 60 seconds is recommended.
   *    @param hold - The optional HTTPBIND hold value.  This is the
   *      number of connections the server will hold at one time.  This
   *      should almost always be set to 1 (the default).
   *    @param route - The optional route value.
   *    @param authcid - The optional alternative authentication identity
   *      (username) if intending to impersonate another user.
   *      When using the SASL-EXTERNAL authentication mechanism, for example
   *      with client certificates, then the authcid value is used to
   *      determine whether an authorization JID (authzid) should be sent to
   *      the server. The authzid should NOT be sent to the server if the
   *      authzid and authcid are the same. So to prevent it from being sent
   *      (for example when the JID is already contained in the client
   *      certificate), set authcid to that same JID. See XEP-178 for more
   *      details.
   *    @param [disconnection_timeout=3000] - The optional disconnection timeout
   *      in milliseconds before _doDisconnect will be called.
   */
  connect(
    jid?: string,
    pass?: string,
    callback?: (status: Status, condition: string, elem: Element) => unknown,
    wait = 59,
    hold?: number,
    route?: string,
    authcid?: string,
    disconnection_timeout?: number
  ): void {
    if (!this.boshServiceUrl && !this.websocketUrl) {
      throw new Error('You must supply a value for either the bosh_service_url or websocket_url or both.');
    }

    this.jid = jid;

    this.sasl.setVariables(this.jid, pass, authcid);

    this.connectCallback = callback;
    this.disconnecting = false;
    this.connected = false;
    this.authenticated = false;
    this.disconnection_timeout = disconnection_timeout;

    // parse jid for domain
    this.domain = getDomainFromJid(this.jid);

    this.changeConnectStatus(Status.CONNECTING, null);

    this.protocolManager.connect(wait, hold, route);
  }

  /**
   *  Attach to an already created and authenticated BOSH session.
   *
   *  This function is provided to allow Strophe to attach to BOSH
   *  sessions which have been created externally, perhaps by a Web
   *  application.  This is often used to support auto-login type features
   *  without putting user credentials into the page.
   *
   *  Parameters:
   *
   *    @param jid - The full JID that is bound by the session.
   *    @param sid - The SID of the BOSH session.
   *    @param rid - The current RID of the BOSH session.  This RID
   *      will be used by the next request.
   *    @param callback The connect callback function.
   *    @param wait - The optional HTTPBIND wait value.  This is the
   *      time the server will wait before returning an empty result for
   *      a request.  The default setting of 60 seconds is recommended.
   *      Other settings will require tweaks to the TIMEOUT value.
   *    @param hold - The optional HTTPBIND hold value.  This is the
   *      number of connections the server will hold at one time.  This
   *      should almost always be set to 1 (the default).
   *    @param wind - The optional HTTBIND window value.  This is the
   *      allowed range of request ids that are valid.  The default is 5.
   */
  attach(
    jid: string,
    sid: string,
    rid: string,
    callback?: (status: Status, condition: string, elem: Element) => unknown,
    wait?: number,
    hold?: number,
    wind?: number
  ): void {
    // @ts-ignore
    if (this.protocolManager.attach) {
      // @ts-ignore
      return this.protocolManager.attach(jid, sid, rid, callback, wait, hold, wind);
    } else {
      const stropheError = new Error('The "attach" method is not available for your connection protocol');
      stropheError.name = 'StropheSessionError';
      throw stropheError;
    }
  }

  /**
   *
   * Attempt to restore a cached BOSH session.
   *
   * This function is only useful in conjunction with providing the
   * “keepalive”:true option when instantiating a new Connection.
   * When “keepalive” is set to true, Strophe will cache the BOSH tokens
   * RID (Request ID) and SID (Session ID) and then when this function is called,
   * it will attempt to restore the session from those cached tokens.
   * This function must therefore be called instead of connect or attach.
   * For an example on how to use it, please see examples/restore.js
   *
   * Parameters:
   *
   *    @param jid - The user’s JID.  This may be a bare JID or a full JID.
   *    @param callback - connect callback function.
   *    @param wait - The optional HTTPBIND wait value.
   *      This is the time the server will wait before returning an empty result for a request.
   *      The default setting of 60 seconds is recommended.
   *    @param hold - The optional HTTPBIND hold value.
   *      This is the number of connections the server will hold at one time.
   *      This should almost always be set to 1 (the default).
   *    @param [wind=5] wind - The optional HTTBIND window value.
   *      This is the allowed range of request ids that are valid.
   */
  restore(jid?: string, callback?: (status: Status, condition: string) => unknown, wait?: number, hold?: number, wind?: number): void {
    if (this.protocolManager instanceof Bosh) {
      this.protocolManager.restore(jid, callback, wait, hold, wind);
    } else {
      const stropheError = new Error('The "restore" method can only be used with a BOSH connection.');
      stropheError.name = 'StropheSessionError';
      throw stropheError;
    }
  }

  /**
   *  User overrideable function that receives XML data coming into the
   *  connection.
   *
   *  The default function does nothing.  User code can override this with
   *  > Connection.xmlInput = function (elem) {
   *  >   (user code)
   *  > };
   *
   *  Due to limitations of current Browsers' XML-Parsers the opening and closing
   *  <stream> tag for WebSocket-Connoctions will be passed as selfclosing here.
   *
   *  BOSH-Connections will have all stanzas wrapped in a <body> tag. See
   *  <Bosh.strip> if you want to strip this tag.
   *
   *  Parameters:
   *
   *    @param _elem - XML data received by the connection.
   */
  xmlInput(_elem: Element): void {
    return;
  }

  /**
   *  User overrideable function that receives XML data sent to the
   *  connection.
   *
   *  The default function does nothing.  User code can override this with
   *  > Connection.xmlOutput = function (elem) {
   *  >   (user code)
   *  > };
   *
   *  Due to limitations of current Browsers' XML-Parsers the opening and closing
   *  <stream> tag for WebSocket-Connoctions will be passed as selfclosing here.
   *
   *  BOSH-Connections will have all stanzas wrapped in a <body> tag. See
   *  <Bosh.strip> if you want to strip this tag.
   *
   *  Parameters:
   *
   *    @param _elem - XML data sent by the connection.
   */
  xmlOutput(_elem: Element): void {
    return;
  }

  /**
   *  User overrideable function that receives the new valid rid.
   *
   *  The default function does nothing. User code can override this with
   *  > Connection.nextValidRid = function (rid) {
   *  >    (user code)
   *  > };
   *
   *  Parameters:
   *
   *    @param  _rid - The next valid rid
   */
  nextValidRid(_rid: number): void {
    return;
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
        this.queueData(el);
      }
    } else if (!(elem instanceof Element)) {
      this.queueData(elem.tree());
    } else {
      this.queueData(elem);
    }
    this.protocolManager.send();
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
    this._onIdle();
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
  sendIQ(el: Element | Builder, callback?: (stanza: Element) => unknown, errback?: (stanza: Element) => unknown, timeout?: number): string {
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
    this.changeConnectStatus(Status.DISCONNECTING, reason);
    if (reason) {
      warn('Disconnect was called because: ' + reason);
    } else {
      info('Disconnect was called');
    }
    if (this.connected) {
      let pres;
      this.disconnecting = true;
      if (this.authenticated) {
        pres = $pres({
          xmlns: NS.CLIENT,
          type: 'unavailable'
        });
      }
      // setup timeout handler
      this.disconnectTimeout = this.handlerService.addSysTimedHandler(this.disconnection_timeout, () => this.onDisconnectTimeout());
      // @ts-ignore
      this.protocolManager.disconnect(pres);
    } else {
      warn('Disconnect was called before Strophe connected to the server');
      this.protocolManager.abortAllRequests();
      this.doDisconnect();
    }
  }

  /**
   *
   *  This is the last piece of the disconnection logic.  This resets the
   *  connection and alerts the user's connection callback.
   */
  doDisconnect(reason?: string) {
    if (typeof this.idleTimeout === 'number') {
      clearTimeout(this.idleTimeout);
    }

    // Cancel Disconnect Timeout
    if (this.disconnectTimeout !== null) {
      this.handlerService.deleteTimedHandler(this.disconnectTimeout);
      this.disconnectTimeout = null;
    }

    debug('_doDisconnect was called');
    this.protocolManager.doDisconnect();

    this.authenticated = false;
    this.disconnecting = false;

    // delete handlers
    this.handlerService.resetHandlers();

    // tell the parent we disconnected
    this.changeConnectStatus(Status.DISCONNECTED, reason);
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
    if (!(await this.sasl.attemptSASLAuth(matched))) {
      this.attemptLegacyAuth();
    }
  }

  /**
   *
   *  Attempt legacy (i.e. non-SASL) authentication.
   */
  attemptLegacyAuth() {
    if (getNodeFromJid(this.jid) === null) {
      // we don't have a node, which is required for non-anonymous
      // client connections
      this.changeConnectStatus(Status.CONNFAIL, ErrorCondition.MISSING_JID_NODE);
      this.disconnect(ErrorCondition.MISSING_JID_NODE);
    } else {
      // Fall back to legacy authentication
      this.changeConnectStatus(Status.AUTHENTICATING, null);
      this.handlerService.addSysHandler((elem) => this._onLegacyAuthIQResult(elem), null, null, null, '_auth_1');
      this.send(
        $iq({
          type: 'get',
          to: this.domain,
          id: '_auth_1'
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
   *  Parameters:
   *    (XMLElement) elem - The stanza that triggered the callback.
   *
   *  Returns:
   *    false to remove the handler.
   */
  _onLegacyAuthIQResult(_elem: Element) {
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

    this.handlerService.addSysHandler((element) => this._auth2_cb(element), null, null, null, '_auth_2');
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

    this.handlerService.addSysHandler((element) => this._onResourceBindResultIQ(element), null, null, null, '_bind_auth_2');

    const resource = getResourceFromJid(this.jid);
    if (resource) {
      this.send($iq({ type: 'set', id: '_bind_auth_2' }).c('bind', { xmlns: NS.BIND }).c('resource', {}).t(resource).tree());
    } else {
      this.send($iq({ type: 'set', id: '_bind_auth_2' }).c('bind', { xmlns: NS.BIND }).tree());
    }
  }

  /**
   *  _Private_ handler for binding result and session start.
   *
   *  Parameters:
   *    (XMLElement) elem - The matching stanza.
   *
   *  Returns:
   *    false to remove the handler.
   */
  _onResourceBindResultIQ(elem: Element) {
    if (elem.getAttribute('type') === 'error') {
      warn('Resource binding failed.');
      const conflict = elem.getElementsByTagName('conflict');
      let condition;
      if (conflict.length > 0) {
        condition = ErrorCondition.CONFLICT;
      }
      this.changeConnectStatus(Status.AUTHFAIL, condition, elem);
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
          this._establishSession();
        } else {
          this.changeConnectStatus(Status.CONNECTED, null);
        }
      }
      return true;
    } else {
      warn('Resource binding failed.');
      this.changeConnectStatus(Status.AUTHFAIL, null, elem);
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
  _establishSession() {
    if (!this.sasl.doSession) {
      throw new Error(
        `Strophe.Connection.prototype._establishSession ` + `called but apparently ${NS.SESSION} wasn't advertised by the server`
      );
    }
    this.handlerService.addSysHandler((element) => this._onSessionResultIQ(element), null, null, null, '_session_auth_2');

    this.send($iq({ type: 'set', id: '_session_auth_2' }).c('session', { xmlns: NS.SESSION }).tree());
  }

  /**
   *  _Private_ handler for the server's IQ response to a client's session
   *  request.
   *
   *  This sets Connection.authenticated to true on success, which
   *  starts the processing of user handlers.
   *
   *  See https://xmpp.org/rfcs/rfc3921.html#session
   *
   *  Note: The protocol for session establishment has been determined as
   *  unnecessary and removed in RFC-6121.
   *
   *  Parameters:
   *    (XMLElement) elem - The matching stanza.
   *
   *  Returns:
   *    false to remove the handler.
   */
  _onSessionResultIQ(elem: Element) {
    if (elem.getAttribute('type') === 'result') {
      this.authenticated = true;
      this.changeConnectStatus(Status.CONNECTED, null);
    } else if (elem.getAttribute('type') === 'error') {
      this.authenticated = false;
      warn('Session creation failed.');
      this.changeConnectStatus(Status.AUTHFAIL, null, elem);
      return false;
    }
    return false;
  }

  /**
   *  _Private_ handler to finish legacy authentication.
   *
   *  This handler is called when the result from the jabber:iq:auth
   *  <iq/> stanza is returned.
   *
   *  Parameters:
   *    (XMLElement) elem - The stanza that triggered the callback.
   *
   *  Returns:
   *    false to remove the handler.
   */
  _auth2_cb(elem: Element) {
    if (elem.getAttribute('type') === 'result') {
      this.authenticated = true;
      this.changeConnectStatus(Status.CONNECTED, null);
    } else if (elem.getAttribute('type') === 'error') {
      this.changeConnectStatus(Status.AUTHFAIL, null, elem);
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
    debug('_onDisconnectTimeout was called');
    this.changeConnectStatus(Status.CONNTIMEOUT, null);
    this.protocolManager.onDisconnectTimeout();
    // actually disconnect
    this.doDisconnect();
    return false;
  }

  /**
   *  _Private_ helper function that makes sure plugins and the user's
   *  callback are notified of connection status changes.
   *
   *  Parameters:
   *
   *    @param status - the new connection status, one of the values
   *      in Status
   *    @param condition - the error condition or null
   *    @param elem - The triggering stanza.
   */
  changeConnectStatus(status: number, condition?: string, elem?: Element): void {
    // notify all plugins listening for status changes
    for (const k in connectionPlugins) {
      if (Object.prototype.hasOwnProperty.call(connectionPlugins, k)) {
        const plugin = this[k];
        if (plugin.statusChanged) {
          try {
            plugin.statusChanged(status, condition);
          } catch (err) {
            log(LogLevel.ERROR, `${k} plugin caused an exception changing status: ${err}`);
          }
        }
      }
    }
    // notify the user's callback
    if (this.connectCallback) {
      try {
        this.connectCallback(status, condition, elem);
      } catch (e) {
        handleError(e);
        log(LogLevel.ERROR, `User connection callback caused an exception: ${e}`);
      }
    }
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
   *    @param req - The request that has data ready.
   */
  dataReceived(req: Element): void {
    const elem = this.protocolManager.reqToData(req as unknown as any);
    if (elem === null) {
      return;
    }

    if (elem.nodeName === this.protocolManager.strip && Array.isArray(elem.childNodes)) {
      this.xmlInput(elem.childNodes[0]);
      this.stanzasInSubject.next(elem.childNodes[0] as Element);
    } else {
      this.xmlInput(elem);
      this.stanzasInSubject.next(elem);
    }

    this.handlerService.removeScheduledHandlers();
    this.handlerService.addScheduledHandlers();

    // handle graceful disconnect
    if (this.disconnecting && this.protocolManager.emptyQueue()) {
      this.doDisconnect();
      return;
    }

    const type = elem.getAttribute('type');
    if (type !== null && type === 'terminate') {
      // Don't process stanzas that come in after disconnect
      if (this.disconnecting) {
        return;
      }
      // an error occurred
      let cond = elem.getAttribute('condition');
      const conflict = elem.getElementsByTagName('conflict');
      if (cond !== null) {
        if (cond === 'remote-stream-error' && conflict.length > 0) {
          cond = 'conflict';
        }
        this.changeConnectStatus(Status.CONNFAIL, cond);
      } else {
        this.changeConnectStatus(Status.CONNFAIL, ErrorCondition.UNKNOWN_REASON);
      }
      this.doDisconnect(cond);
      return;
    }

    // send each incoming stanza through the handler chain
    forEachChild(elem, null, (child) => {
      this.handlerService.checkHandlerChain(this.authenticated, child);
    });
  }

  /**
   *  _Private_ handler to process events during idle cycle.
   *
   *  This handler is called every 100ms to fire timed handlers that
   *  are ready and keep poll requests going.
   */
  _onIdle(): void {
    this.handlerService.addTimedHandlersScheduledForAddition();
    this.handlerService.removeTimedHandlersScheduledForDeletion();
    this.handlerService.callReadyTimedHandlers(this.authenticated);

    clearTimeout(this.idleTimeout);
    this.protocolManager.onIdle();

    // reactivate the timer only if connected
    if (this.connected) {
      // @ts-ignore
      this.idleTimeout = setTimeout(() => this._onIdle(), 100);
    }
  }

  /**
   *  _Private_ handler for initial connection request.
   *
   *  This handler is used to process the initial connection request
   *  response from the BOSH server. It is used to set up authentication
   *  handlers and start the authentication process.
   *
   *  SASL authentication will be attempted if available, otherwise
   *  the code will fall back to legacy authentication.
   *
   *  Parameters:
   *
   *    @param req - The current request.
   *    @param _callback - low level (xmpp) connect callback function.
   *      Useful for plugins with their own xmpp connect callback (when they
   *      want to do something special).
   */
  _connect_cb(req: Element, _callback: () => void) {
    debug('_connect_cb was called');
    this.connected = true;

    let bodyWrap: Element;
    try {
      bodyWrap = this.protocolManager.reqToData(req as unknown as any);
    } catch (e) {
      if (e.name !== ErrorCondition.BAD_FORMAT) {
        throw e;
      }
      this.changeConnectStatus(Status.CONNFAIL, ErrorCondition.BAD_FORMAT);
      this.doDisconnect(ErrorCondition.BAD_FORMAT);
    }
    if (!bodyWrap) {
      return;
    }

    if (bodyWrap.nodeName === this.protocolManager.strip && bodyWrap.childNodes.length) {
      this.xmlInput(bodyWrap.childNodes[0] as Element);
    } else {
      this.xmlInput(bodyWrap);
    }

    const conncheck = this.protocolManager.connectCb(bodyWrap);
    if (conncheck === Status.CONNFAIL) {
      return;
    }

    // Check for the stream:features tag
    let hasFeatures;
    if (bodyWrap.getElementsByTagNameNS) {
      hasFeatures = bodyWrap.getElementsByTagNameNS(NS.STREAM, 'features').length > 0;
    } else {
      hasFeatures = bodyWrap.getElementsByTagName('stream:features').length > 0 || bodyWrap.getElementsByTagName('features').length > 0;
    }
    if (!hasFeatures) {
      this.protocolManager.noAuthReceived(_callback);
      return;
    }

    const matched = Array.from(bodyWrap.getElementsByTagName('mechanism'))
      .map((m) => this.sasl.mechanisms[m.textContent])
      .filter((m) => m);

    if (matched.length !== 0 && this.do_authentication !== false) {
      this.authenticate(matched).then(_callback);
    }

    if (bodyWrap.getElementsByTagName('auth').length === 0) {
      // There are no matching SASL mechanisms and also no legacy
      // auth available.
      this.protocolManager.noAuthReceived(_callback);
    }
  }

  static async create(
    service: string,
    domain: string,
    authenticationMode = AuthenticationMode.LOGIN,
    prebindUrl?: string,
    credentialsUrl?: string
  ): Promise<Connection> {
    const connectionUrls = this.getConnectionsUrls(service, domain);
    const options = { keepalive: true, explicitResourceBinding: true };

    if (!connectionUrls.boshServiceUrl && !connectionUrls.websocketUrl && connectionUrls.domain) {
      const { boshServiceUrl, websocketUrl } = await this.discoverConnectionMethods(connectionUrls.domain);
      if (!connectionUrls.boshServiceUrl && authenticationMode === AuthenticationMode.PREBIND) {
        throw new Error("authentication is set to 'prebind' but we don't have a BOSH connection");
      }
      return new Connection(
        websocketUrl ?? boshServiceUrl,
        options,
        authenticationMode,
        prebindUrl,
        boshServiceUrl,
        websocketUrl,
        credentialsUrl
      );
    }

    const connection_url = connectionUrls.websocketUrl ?? connectionUrls.boshServiceUrl;
    return new Connection(
      connection_url,
      options,
      authenticationMode,
      prebindUrl,
      connectionUrls.boshServiceUrl,
      connectionUrls.websocketUrl,
      credentialsUrl
    );
  }

  static getConnectionsUrls(service: string, domain: string): { domain: string; websocketUrl: string; boshServiceUrl: string } {
    const isWebsocket = /wss?:\/\//.test(service);

    return {
      domain,
      boshServiceUrl: isWebsocket ? undefined : service,
      websocketUrl: isWebsocket ? service : undefined
    };
  }

  /**
   * Logs the user in.
   *
   * If called without any parameters, Converse will try
   * to log the user in by calling the `prebind_url` or `credentials_url` depending
   * on whether prebinding is used or not.
   *
   * @param {string} [jid]
   * @param {string} [password?]
   * @param {boolean} [automatic=false] - An internally used flag that indicates whether
   *  this method was called automatically once the connection has been
   *  initialized. It's used together with the `auto_login` configuration flag
   *  to determine whether Converse should try to log the user in if it
   *  fails to restore a previous auth'd session.
   *  @param reconnecting
   */
  async login(jid: string, password?: string, automatic = false, reconnecting = false): Promise<void> {
    this.setUserJID(jid);

    // See whether there is a BOSH session to re-attach to
    if (this.protocolManager instanceof Bosh && this.protocolManager.restoreBOSHSession(reconnecting)) {
      return;
    }
    if (this.protocolManager instanceof Bosh && this.handlePreBind && !automatic) {
      return this.protocolManager.startNewPreboundBOSHSession(reconnecting);
    }

    await this.attemptNewSession(this.authenticationMode, jid, password, automatic);
  }

  async loginNew(username: string, domain: string, service: string, password: string): Promise<void> {
    const separator = '@';
    const safeUsername = username.includes(separator) ? username.split(separator)[0] : username;
    const jid = safeUsername + separator + domain;

    const conn = await Connection.create(service, domain);
    return new Promise((resolve, reject) => {
      conn.connect(jid, password, this.createConnectionStatusHandler(safeUsername, domain, resolve, reject));
    });
  }

  createConnectionStatusHandler(
    username: string,
    domain: string,
    resolve: () => void,
    reject: (reason?: string) => void
  ): (status: Status, value: string) => void {
    return (status: Status, value: string) => {
      log(LogLevel.INFO, `status update; status=${status}, value=${JSON.stringify(value)}`);

      switch (status) {
        case Status.REDIRECT:
        case Status.ATTACHED:
        case Status.CONNECTING:
        case Status.REGISTER:
        case Status.REGISTERED:
        case Status.AUTHENTICATING:
        case Status.DISCONNECTING:
        case Status.DISCONNECTED:
          break;
        case Status.CONNECTED:
          resolve();
          break;
        case Status.ERROR:
          reject(`An error occurred connecting, failed with status code: ${status}`);
          break;
        case Status.CONNFAIL:
          reject(`The connection failed, failed with status code: ${status}`);
          break;
        case Status.AUTHFAIL:
          reject(`The authentication failed, failed with status code: ${status}`);
          break;
        case Status.CONNTIMEOUT:
          reject(`The connection timed out, failed with status code: ${status}`);
          break;
        case Status.CONFLICT:
        case Status.REGIFAIL:
        case Status.NOTACCEPTABLE:
          reject(`Failed with status code: ${status}`);
          break;
        case Status.BINDREQUIRED:
          this.bind();
          break;
        default:
          log(LogLevel.ERROR, `Unhandled connection status; status=${status}`);
      }

      this.stateSubject.next(status);
    };
  }

  /**
   * Adds support for XEP-0156 by querying the XMPP server for alternate
   * connection methods. This allows users to use the websocket or BOSH
   * connection of their own XMPP server
   *
   * @param domain the xmpp server domain to requests the connection urls from
   */
  static async discoverConnectionMethods(domain: string): Promise<{ websocketUrl: string; boshServiceUrl: string }> {
    // Use XEP-0156 to check whether this host advertises websocket or BOSH connection methods.
    const options = {
      mode: 'cors' as RequestMode,
      headers: {
        Accept: 'application/xrd+xml, text/xml'
      }
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
      log(LogLevel.WARN, 'Neither BOSH nor WebSocket connection methods have been specified with XEP-0156.');
      return null;
    }

    const websocketUrl = ws_methods.pop();
    const boshServiceUrl = bosh_methods.pop();
    return { websocketUrl, boshServiceUrl };
  }

  private queueData(element: Element): void {
    if (!element || !element.tagName || !element.childNodes) {
      const stropheError = new Error('Cannot queue non-DOMElement.');
      stropheError.name = 'StropheError';
      throw stropheError;
    }
    this.data.push(element);
  }

  async attemptNewSession(mode: AuthenticationMode, jid: string, password: string, automatic = false): Promise<void> {
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

    const message = '';
    this.connectionStatusSubject.next({ status: Status.AUTHFAIL, message });
    this.disconnect(message);
  }

  async getLoginCredentialsFromBrowser(): Promise<{ password: any; jid: string }> {
    try {
      // https://github.com/microsoft/TypeScript/issues/34550
      const creds = await navigator.credentials.get({ password: true } as unknown);
      if (creds && creds.type == 'password' && Connection.isValidJID(creds.id)) {
        this.setUserJID(creds.id);
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

  fetchLoginCredentialsInterceptor = async (xhr: XMLHttpRequest): Promise<XMLHttpRequest> => xhr;

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
      fromRxjs<Promise<Credentials>>(
        new Promise(async (resolve, reject) => {
          let xhr = new XMLHttpRequest();
          xhr.open('GET', credentialsURL, true);
          xhr.setRequestHeader('Accept', 'application/json, text/javascript');
          xhr.onload = () => {
            if (xhr.status >= 200 && xhr.status < 400) {
              const data = JSON.parse(xhr.responseText);
              this.setUserJID(data.jid);
              resolve({
                jid: data.jid,
                password: data.password
              });
            } else {
              reject(new Error(`${xhr.status}: ${xhr.responseText}`));
            }
          };
          xhr.onerror = reject;
          /**
           * *Hook* which allows modifying the server request
           *
           * @event _converse#beforeFetchLoginCredentials
           */
          xhr = await this.fetchLoginCredentialsInterceptor(xhr);
          xhr.send();
        })
      ).pipe(debounceTime(wait))
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
    if (this.protocolManager instanceof StropheWebsocket && this.boshServiceUrl) {
      this.setUserJID(this.bareJid);
      this.doDisconnect();
      this.protocolManager = new Bosh(this, null);
      this.service = this.boshServiceUrl;
    } else if (this.protocolManager instanceof Bosh && this.websocketUrl) {
      if (this.authenticationMode === AuthenticationMode.ANONYMOUS) {
        // When reconnecting anonymously, we need to connect with only
        // the domain, not the full JID that we had in our previous
        // (now failed) session.
        this.setUserJID(this.domainJid);
      } else {
        this.setUserJID(this.bareJid);
      }
      this.doDisconnect();
      this.protocolManager = new StropheWebsocket(this, this.stanzasInSubject);
      this.service = this.websocketUrl;
    }
  }

  async reconnect(): Promise<void> {
    this.reconnecting = true;
    log(LogLevel.DEBUG, 'RECONNECTING: the connection has dropped, attempting to reconnect.');
    const isAuthenticationAnonymous = this.authenticationMode === AuthenticationMode.ANONYMOUS;
    const { status } = await firstValueFrom(this.connectionStatus$);
    if (status === Status.CONNFAIL) {
      this.switchTransport();
    } else if (status === Status.AUTHFAIL && isAuthenticationAnonymous) {
      // When reconnecting anonymously, we need to connect with only
      // the domain, not the full JID that we had in our previous
      // (now failed) session.
      this.setUserJID(this.domainJid);
    }

    this.connectionStatusSubject.next({ status: Status.RECONNECTING, message: 'The connection has dropped, attempting to reconnect.' });
    /**
     * Triggered when the connection has dropped, but we will attempt
     * to reconnect again.
     */
    this.willReconnectSubject.next();

    this.reset();
    await this.login(this.jid, undefined, false, true);
  }

  async logOut(): Promise<void> {
    await new Promise((resolve) => this.sendPresence($pres({ type: 'unavailable' }), resolve));
    this.stateSubject.next(Status.DISCONNECTED); // after last send
    this.disconnect('regular logout');
    this.reset();
  }

  /**
   * Promise resolves if user account is registered successfully,
   * rejects if an error happens while registering, e.g. the username is already taken.
   */
  async register(username: string, password: string, service: string, domain: string): Promise<void> {
    const nsRegister = 'jabber:iq:register';

    let registering = false;
    let processed_features = false;
    let connect_cb_data: { req: Element } = { req: null };

    if (username.includes('@')) {
      log(LogLevel.WARN, 'username should not contain domain, only local part, this can lead to errors!');
    }

    await this.logOut();
    const conn = await Connection.create(service, domain);

    const readyToStartRegistration = new Promise<void>((resolve) => {
      // hooking strophe's _connect_cb
      const connect_callback = conn._connect_cb.bind(conn);
      conn._connect_cb = (req, callback) => {
        if (registering) {
          // Save this request in case we want to authenticate later
          connect_cb_data = { req };
          resolve();
          return;
        }

        if (processed_features) {
          // exchange Input hooks to not print the stream:features twice
          const xmlInput = (el: Element): void => conn.xmlInput(el);
          conn.xmlInput = () => {};
          connect_callback(req, callback);
          conn.xmlInput = xmlInput;
        }

        connect_callback(req, callback);
      };

      // hooking strophe`s authenticate
      const authOld = async (matched: SASLMechanism[]): Promise<void> => conn.authenticate(matched);
      conn.authenticate = async (matched: SASLMechanism[]): Promise<void> => {
        const isMatched = typeof matched !== 'undefined';
        if (isMatched) {
          await authOld(matched);
          return;
        }

        if (!username || !domain || !password) {
          return;
        }

        this.sasl.setVariables(username + '@' + domain, password);

        const req = connect_cb_data.req;
        conn._connect_cb(req, connect_callback);
      };
    });

    // anonymous connection
    await conn.connect(
      domain,
      '',
      this.createConnectionStatusHandler(
        username,
        domain,
        () => {},
        () => {}
      )
    );

    registering = true;
    await readyToStartRegistration;

    await this.queryForRegistrationForm(conn, nsRegister);
    await this.submitRegisterInformationQuery(conn, username, password, nsRegister);

    registering = false;
    processed_features = true;
    // here we should have switched after processing the feature's stanza to the regular callback after login
    conn.reset();
    await this.logOut();
    await this.loginNew(username, domain, service, password);
  }

  private async queryForRegistrationForm(conn: Connection, nsRegister: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      // send a get request for registration, to get all required data fields
      conn.handlerService.addSysHandler(
        (stanza) => {
          const query = stanza.getElementsByTagName('query');
          if (query.length !== 1) {
            conn.changeConnectStatus(Status.REGIFAIL, 'unknown');
            reject('registration failed by unknown reason');
            return false;
          }

          conn.changeConnectStatus(Status.REGISTER, null);

          resolve();
          return false;
        },
        null,
        'iq',
        null,
        null
      );

      conn.sendIQ($iq({ type: 'get' }).c('query', { xmlns: nsRegister }).tree());
    });
  }

  private async submitRegisterInformationQuery(conn: Connection, username: string, password: string, nsRegister: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      conn.handlerService.addSysHandler(
        (stanza) => {
          let error = null;

          if (stanza.getAttribute('type') === 'error') {
            error = stanza.getElementsByTagName('error');
            if (error.length !== 1) {
              conn.changeConnectStatus(Status.REGIFAIL, 'unknown');
              reject();
              return false;
            }

            // this is either 'conflict' or 'not-acceptable'
            error = error[0].firstChild.nodeName.toLowerCase();
            if (error === 'conflict') {
              conn.changeConnectStatus(Status.CONFLICT, error);
              reject();
            } else if (error === 'not-acceptable') {
              conn.changeConnectStatus(Status.NOTACCEPTABLE, error);
              reject();
            } else {
              conn.changeConnectStatus(Status.REGIFAIL, error);
              reject();
            }
          } else {
            conn.changeConnectStatus(Status.REGISTERED, null);
            resolve();
          }

          return false; // makes strophe delete the sysHandler
        },
        null,
        'iq',
        null,
        null
      );

      conn.sendIQ($iq({ type: 'set' }).c('query', { xmlns: nsRegister }).c('username', {}, username).c('password', {}, password));
    });
  }

  /**
   * Called as soon as a new connection has been established, either
   * by logging in or by attaching to an existing BOSH session.
   *
   * @method Connection.onConnected
   * @param {boolean} reconnecting - Whether we reconnected from an earlier dropped session.
   */
  onConnected(reconnecting: boolean): void {
    this.flush(); // Solves problem of returned PubSub BOSH response not received by browser
    this.setUserJID(this.jid);

    /**
     * Synchronous event triggered after we've sent an IQ to bind the
     * user's JID resource for this session.
     */
    this.afterResourceBindingSubject.next();

    if (reconnecting) {
      /**
       * After the connection has dropped and we have reconnected.
       * Any Strophe stanza handlers will have to be registered anew.
       */
      this.reconnectedSubject.next();
      this.reconnecting = false;
    } else {
      /**
       * Triggered after the connection has been established
       */
      this.connectedSubject.next();
    }
  }

  finishDisconnection(): void {
    // Properly tear down the session so that it's possible to manually connect again.
    log(LogLevel.DEBUG, 'DISCONNECTED');
    this.reset();
    this.clearSession();
    /**
     * Triggered after we disconnected from the XMPP server.
     */
    this.disconnectedSubject.next();
  }

  /**
   * Gets called once strophe's status reaches Status.DISCONNECTED.
   * Will either start a teardown process for converse.js or attempt
   * to reconnect.
   *
   */
  private async onDisconnected(disconnectionStatus: Status, disconnectionReason: string, automaticLogin?: boolean): Promise<void> {
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

    const unrecoverableDisconnectionCause = [ErrorCondition.NO_AUTH_MECH, 'host-unknown', 'remote-connection-failed'].includes(
      disconnectionReason
    );
    const isAbleToReconnect = disconnectionStatus !== Status.DISCONNECTING || unrecoverableDisconnectionCause;

    if (failedAuthenticationWithCredentialsUrl || isConnectionAnonymous || isAbleToReconnect) {
      await this.reconnect();
      return;
    }

    this.finishDisconnection();
    return;
  }

  // TODO: Ensure can be replaced by strophe-connection.service then delete
  /**
   * Callback method called by Strophe as the Connection goes
   * through various states while establishing or tearing down a
   * connection.
   *
   * @param {number} status
   * @param {string} message
   */
  async onConnectStatusChanged(status: Status, message: string, reconnecting: boolean): Promise<void> {
    switch (status) {
      case Status.REDIRECT:
      case Status.CONNTIMEOUT:
      case Status.RECONNECTING:
      case Status.REGIFAIL:
      case Status.REGISTER:
      case Status.REGISTERED:
      case Status.CONFLICT:
      case Status.NOTACCEPTABLE:
      default:
        break;
      case Status.ERROR:
      case Status.CONNECTING:
      case Status.CONNFAIL:
      case Status.AUTHENTICATING:
      case Status.DISCONNECTING:
      case Status.ATTACHFAIL:
        this.connectionStatusSubject.next({ status, message });
        break;
      case Status.DISCONNECTED:
      case Status.AUTHFAIL:
        this.connectionStatusSubject.next({ status, message });
        await this.onDisconnected(status, message);
        break;
      case Status.CONNECTED:
      case Status.ATTACHED:
        this.connectionStatusSubject.next({ status, message });

        const isConnected = status === Status.CONNECTED;
        if (reconnecting) {
          log(LogLevel.DEBUG, isConnected ? 'Reconnected' : 'Reattached');
        } else {
          log(LogLevel.DEBUG, isConnected ? 'Connected' : 'Attached');
        }

        this.onConnected(reconnecting);
        break;
      case Status.BINDREQUIRED:
        this.bind();
        break;
    }
  }

  clearSession(): void {
    delete this.domainJid;
    delete this.bareJid;
    delete this.session;
    this.setProtocol();
  }
}
